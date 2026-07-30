import assert from "node:assert/strict";
import { expect } from "chai";
import { describe, it, mock } from "node:test";

import {
  freshFor100,
  uniqueCacheName,
} from "../../test/v2AcceptanceHelpers.js";
import Cache from "../Cache.js";
import {
  idStartsWith,
  MemoryStore,
  resourceType,
  type ResourceTypes,
} from "../index.js";
import { bulkProducerByIdType } from "./bulkProducerByIdType.js";
import { wrapBulkProducer } from "./wrapBulkProducer.js";

/**
 * `bulkProducerByIdType`'s own contract, driven CACHE-FREE. That is the only
 * level several of these behaviours are observable at: the per-type `Error`
 * slots that error isolation produces are exactly what a wrapper consumes and
 * turns into per-request failures, so "one type's failure does not discard a
 * sibling's results" and "a non-Error rejection is wrapped" can only be pinned
 * here. Routing failures (`UnroutableIdError`) are shared with the single helper
 * and tested in producerByIdType.test.ts; coverage *enforcement* by the wrapper
 * lives in coverageRuntime.test.ts.
 *
 * These registries are deliberately local copies rather than shared fixtures:
 * they are free to diverge from any other suite's.
 */
const registry = {
  site_day: resourceType<string>()({ matches: idStartsWith("site:") }),
  business_slice: resourceType<string>()({ matches: idStartsWith("biz:") }),
} satisfies ResourceTypes;

const emptyRequest = { params: {}, directives: {} } as const;

/**
 * Content, or the Error's message, per slot. Every slot is filled: a
 * sub-producer whose count disagrees with its slice rejects the invocation, so a
 * resolved result array is dense.
 */
const slots = (results: readonly ({ content: string } | Error)[]) =>
  Array.from(results, (it) =>
    it instanceof Error ? `!${it.message}` : it.content,
  );

describe("bulkProducerByIdType", () => {
  it("an empty record throws at construction time, while a bare bulk producer function is a legal whole-registry producer", async () => {
    const cache = new Cache({
      store: new MemoryStore(),
      name: uniqueCacheName("construct-bulk"),
      resourceTypes: registry,
    });
    try {
      expect(() => bulkProducerByIdType(registry, {})).to.throw();
      const bare = wrapBulkProducer({ cache }, async (reqs) =>
        reqs.map(() => ({ content: "x", directives: freshFor100 })),
      );
      const results = await bare([{ id: "site:1" }, { id: "biz:1" }]);
      expect(
        results.map((it) => (it instanceof Error ? it : it.content)),
      ).to.deep.equal(["x", "x"]);
    } finally {
      await cache.close();
    }
  });

  it("splits a mixed batch with no Cache in existence, calling each sub-producer once with its own type-pure slice", async () => {
    const siteBulk = mock.fn(async (reqs: readonly { readonly id: string }[]) =>
      reqs.map((req) => ({
        content: `site-${req.id}`,
        directives: freshFor100,
      })),
    );
    const bizBulk = mock.fn(async (reqs: readonly { readonly id: string }[]) =>
      reqs.map((req) => ({
        content: `biz-${req.id}`,
        directives: freshFor100,
      })),
    );
    const producer = bulkProducerByIdType(registry, {
      site_day: siteBulk,
      business_slice: bizBulk,
    });

    // Interleaved so a positional-reassembly bug can't pass: each result must
    // land back on its OWN request's index.
    const results = await producer([
      { ...emptyRequest, id: "site:1" },
      { ...emptyRequest, id: "biz:1" },
      { ...emptyRequest, id: "site:2" },
    ]);
    expect(slots(results)).to.deep.equal([
      "site-site:1",
      "biz-biz:1",
      "site-site:2",
    ]);

    // One call each, and neither slice mixed types.
    expect(siteBulk.mock.callCount()).to.equal(1);
    expect(bizBulk.mock.callCount()).to.equal(1);
    expect(
      siteBulk.mock.calls[0]?.arguments[0]?.map((req) => req.id),
    ).to.deep.equal(["site:1", "site:2"]);
    expect(
      bizBulk.mock.calls[0]?.arguments[0]?.map((req) => req.id),
    ).to.deep.equal(["biz:1"]);
  });

  it("reassembles by POSITION, so a repeated id with different params gets each slot's own result", async () => {
    // Keyed by the request's index WITHIN its slice, so an id-keyed reassembly
    // would hand both `site:dup` slots the same element.
    const producer = bulkProducerByIdType(registry, {
      site_day: async (reqs) =>
        reqs.map((req, i) => ({
          content: `site-${req.id}#${String(i)}`,
          directives: freshFor100,
        })),
    });

    const results = await producer([
      { ...emptyRequest, id: "site:dup", params: { v: "a" } },
      { ...emptyRequest, id: "site:dup", params: { v: "b" } },
    ]);
    expect(slots(results)).to.deep.equal([
      "site-site:dup#0",
      "site-site:dup#1",
    ]);
  });

  it("a REJECTING sub-producer fills only its own type's slots with the error; the other type is delivered normally", async () => {
    const boom = new Error("site origin unreachable");
    const bizBulk = mock.fn(async (reqs: readonly { readonly id: string }[]) =>
      reqs.map((req) => ({
        content: `biz-${req.id}`,
        directives: freshFor100,
      })),
    );
    const producer = bulkProducerByIdType(registry, {
      site_day: async () => {
        throw boom;
      },
      business_slice: bizBulk,
    });

    // Resolves rather than rejecting: a sub-producer's failure is per-request,
    // not an invocation failure.
    const results = await producer([
      { ...emptyRequest, id: "site:1" },
      { ...emptyRequest, id: "biz:1" },
      { ...emptyRequest, id: "site:2" },
    ]);
    expect(results[0]).to.equal(boom);
    expect(results[2]).to.equal(boom);
    expect(slots(results)).to.deep.equal([
      "!site origin unreachable",
      "biz-biz:1",
      "!site origin unreachable",
    ]);
    // The healthy slice still ran: the failure didn't cancel or skip it.
    expect(bizBulk.mock.callCount()).to.equal(1);
  });

  it("a sub-producer that fails SYNCHRONOUSLY is isolated to its own type's slots, like a rejection", async () => {
    // The isolation contract has to cover a synchronous throw, not just a
    // rejection: a non-async sub-producer that validates its batch (or whose
    // first synchronous step throws -- the hashed-input wrappers' internal
    // producers read their input registry synchronously) never reaches a handler
    // attached to its return value. Failing the whole invocation instead would
    // discard `business_slice`'s already-computed result and its store, for a
    // failure only `site_day` had.
    const boom = new Error("sync boom");
    const producer = bulkProducerByIdType(registry, {
      site_day: (reqs) => {
        expect(reqs.length).to.equal(2);
        throw boom;
      },
      business_slice: async (reqs) =>
        reqs.map((req) => ({
          content: `biz-${req.id}`,
          directives: freshFor100,
        })),
    });

    const results = await producer([
      { ...emptyRequest, id: "site:1" },
      { ...emptyRequest, id: "biz:1" },
      { ...emptyRequest, id: "site:2" },
    ]);

    expect(results[0]).to.equal(boom);
    expect(results[2]).to.equal(boom);
    expect(slots(results)).to.deep.equal([
      "!sync boom",
      "biz-biz:1",
      "!sync boom",
    ]);
  });

  it("a NON-Error rejection is wrapped in an Error naming the resource type, keeping the original as `cause`", async () => {
    // A raw non-Error in a result slot would be read as a successful producer
    // result, so it must not be stored as-is.
    const producer = bulkProducerByIdType(registry, {
      site_day: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "just a string";
      },
    });

    const results = await producer([{ ...emptyRequest, id: "site:1" }]);
    const slot = results[0];
    expect(slot).to.be.instanceOf(Error);
    expect((slot as Error).message).to.match(
      /bulkProducerByIdType: the "site_day" producer rejected with a non-Error value/,
    );
    expect((slot as Error).cause).to.equal("just a string");
  });

  it("an UNDER-RETURNING sub-producer fails the whole invocation, naming it and both counts", async () => {
    // Padding the missing slots with an Error would turn a producer contract
    // violation into a per-request failure and hide the bug. Failing here rather
    // than leaving holes for the wrapper's own check is what lets the error name
    // the sub-producer at fault: the wrapper sees only the merged batch.
    // A HEALTHY sibling is wired up alongside to pin the blast radius: it still
    // runs, and one slice's contract violation still fails the whole invocation,
    // so its results are not delivered either.
    const bizBulk = mock.fn(
      async (reqs: readonly { readonly id: string }[]) =>
        reqs.map((req) => ({
          content: `biz-${req.id}`,
          directives: freshFor100,
        })),
    );
    const producer = bulkProducerByIdType(registry, {
      site_day: async (reqs) =>
        reqs.slice(0, 1).map((req) => ({
          content: `site-${req.id}`,
          directives: freshFor100,
        })),
      business_slice: bizBulk,
    });

    await assert.rejects(
      async () =>
        producer([
          { ...emptyRequest, id: "site:1" },
          { ...emptyRequest, id: "biz:1" },
          { ...emptyRequest, id: "site:2" },
        ]),
      /the "site_day" producer returned a result count \(1\) that does not match the number of requests in its slice \(2\)/,
    );
    expect(bizBulk.mock.callCount()).to.equal(1);
  });

  it("an OVER-RETURNING sub-producer fails the whole invocation too", async () => {
    // Extras mean this sub-producer disagrees with the slice it was handed, so
    // its positional pairing is no longer trustworthy. The wrapper rejects a bare
    // producer's over-return for the same reason (wrapBulkProducer.test.ts); what
    // this level adds is naming which sub-producer did it.
    const producer = bulkProducerByIdType(registry, {
      site_day: async (reqs) => [
        ...reqs.map((req) => ({
          content: `site-${req.id}`,
          directives: freshFor100,
        })),
        { content: "extra-nobody-asked-for", directives: freshFor100 },
      ],
    });

    await assert.rejects(
      async () => producer([{ ...emptyRequest, id: "site:1" }]),
      /the "site_day" producer returned a result count \(2\) that does not match the number of requests in its slice \(1\)/,
    );
  });
});
