import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  freshFor100,
  staleWhileRevalidating,
  uniqueCacheName,
} from "../../test/v2AcceptanceHelpers.js";
import Cache from "../cache/Cache.js";
import {
  idStartsWith,
  MemoryStore,
  resourceType,
  type ResourceTypes,
} from "../index.js";
import { bulkProducerByIdType } from "../producer-builders/bulkProducerByIdType.js";
import { producerByIdType } from "../producer-builders/producerByIdType.js";
import wrapProducer from "./wrapProducer.js";

/**
 * The client passes a complete request to the producer as the same object
 * that the caller passed, never as a copy. `wrapHashedInputProducer` relies on
 * this: it finds each request's input by the request object (see
 * `ReachesProducerAsIs`). These tests pin the guarantee for every producer
 * form, so a copy added anywhere on the way to the producer fails here, not
 * only as a missing input in the hashed-input wrapper.
 */
const registry = {
  site: resourceType<string>()({ matches: idStartsWith("site:") }),
} satisfies ResourceTypes;

type Request = { readonly id: string };
type Received = Request[];

const makeCache = () =>
  new Cache({
    store: new MemoryStore(),
    name: uniqueCacheName("request-identity"),
    resourceTypes: registry,
  });

/** Each producer form, built to record the request objects it receives. */
const forms = {
  "single producer": (
    cache: ReturnType<typeof makeCache>,
    received: Received,
  ) =>
    wrapProducer({
      cache,
      produce: async (req: Request) => {
        received.push(req);
        return { content: req.id, directives: freshFor100 };
      },
    }),
  "bulk producer": (cache: ReturnType<typeof makeCache>, received: Received) =>
    wrapProducer({
      cache,
      produceMany: async (reqs: readonly Request[]) => {
        received.push(...reqs);
        return reqs.map((req) => ({
          content: req.id,
          directives: freshFor100,
        }));
      },
    }),
  producerByIdType: (cache: ReturnType<typeof makeCache>, received: Received) =>
    wrapProducer({
      cache,
      produce: producerByIdType(registry, {
        site: async (req) => {
          received.push(req);
          return { content: req.id, directives: freshFor100 };
        },
      }),
    }),
  bulkProducerByIdType: (
    cache: ReturnType<typeof makeCache>,
    received: Received,
  ) =>
    wrapProducer({
      cache,
      produceMany: bulkProducerByIdType(registry, {
        site: async (reqs) => {
          received.push(...reqs);
          return reqs.map((req) => ({
            content: req.id,
            directives: freshFor100,
          }));
        },
      }),
    }),
};

const completeRequest = (id: `site:${string}`) => ({
  id,
  params: {},
  directives: {},
});

describe("the producer receives the caller's complete request object", () => {
  Object.entries(forms).forEach(([name, build]) => {
    describe(name, () => {
      it("on a miss", async () => {
        const received: Received = [];
        const client = build(makeCache(), received);
        const first = completeRequest("site:a");
        const second = completeRequest("site:b");

        await client.getMany([first, second]);
        await client.close();

        assert.equal(received.length, 2);
        assert.ok(received.includes(first));
        assert.ok(received.includes(second));
      });

      it("when a request rides another's pending task, as the starting request's object", async () => {
        const received: Received = [];
        const client = build(makeCache(), received);
        const starter = completeRequest("site:a");
        const rider = completeRequest("site:a");

        await Promise.all([client.get(starter), client.get(rider)]);
        await client.close();

        assert.deepEqual(received, [starter]);
        assert.equal(received[0], starter);
      });
    });
  });

  it("on a stale-while-revalidate refresh", async () => {
    const received: Request[] = [];
    const client = wrapProducer({
      cache: makeCache(),
      produce: async (req: Request) => {
        received.push(req);
        return staleWhileRevalidating(req.id);
      },
    });
    await client.get(completeRequest("site:a"));
    const reader = completeRequest("site:a");

    await client.get(reader);
    await client.close();

    assert.equal(received.length, 2);
    assert.equal(received[1], reader);
  });

  it("fills in an incomplete request as a copy", async () => {
    const received: Received = [];
    const client = forms["single producer"](makeCache(), received);
    const partial = { id: "site:a" as const };

    await client.get(partial);
    await client.close();

    assert.notEqual(received[0], partial);
    assert.deepEqual(received, [{ id: "site:a", params: {}, directives: {} }]);
  });
});
