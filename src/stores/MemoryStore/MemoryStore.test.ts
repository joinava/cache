import assert from "node:assert/strict";
import { it } from "node:test";
import MemoryStore from "./MemoryStore.js";
import type { CacheSpec } from "../../types/00_CacheSpec.js";
import type { AnyParams } from "../../types/01_Params.js";
import {
  normalizeParams,
  normalizeVary,
  normalizeProducerDirectives,
} from "../../utils/normalization.js";

it(
  "an awaited bulk MemoryStore write is visible before a dependent delete",
  { timeout: 10_000 },
  async () => {
    const store = new MemoryStore<CacheSpec<string, number>>();
    const params = normalizeParams<AnyParams>(
      (name) => name,
      (_name, value) => value,
      {},
    );
    const vary = normalizeVary<AnyParams>(
      (name) => name,
      (_name, value) => value,
      {},
    );
    const count = 10_000;
    try {
      await store.store(
        Array.from({ length: count }, (_, index) => ({
          entry: {
            id: String(index),
            content: index,
            vary,
            validators: {},
            directives: normalizeProducerDirectives({ freshUntilAge: 60 }),
            date: new Date(0),
            initialAge: 0,
          },
          maxStoreForSeconds: 60,
        })),
      );
      const request = { id: String(count - 1), params };
      assert.deepEqual(
        (await store.get(request)).map(({ content }) => content),
        [count - 1],
      );
      await store.delete(request.id);
      assert.deepEqual(await store.get(request), []);
    } finally {
      await store.close();
    }
  },
);
