import { normalizeProducerDirectives } from "../../utils/normalization.js";
import assert from "node:assert/strict";
import fc from "fast-check";
import { describe, it } from "node:test";
import {
  postgresStoreFixture,
  postgresEnvironmentIsConfigured,
} from "../../../test/fixtures.js";
import type { NormalizedVary } from "../../types/index.js";
const emptyVary = {} as NormalizedVary<{}>;
describe(
  "Postgres concurrent writes",
  postgresEnvironmentIsConfigured()
    ? {}
    : { skip: "Postgres is not configured" },
  () => {
    it("does not deadlock when concurrent store() calls hit overlapping slots in different orders", async (t) => {
      // Postgres processes a multi-row INSERT ... ON CONFLICT DO UPDATE's rows
      // in order, locking each conflicting row as it goes. If concurrent
      // store() calls could lock the same rows in DIFFERENT orders, each could
      // grab a row the other is waiting on, and Postgres would abort one with
      // a "deadlock detected" error (40P01) after deadlock_timeout. The store
      // must therefore order its rows deterministically, so concurrent calls
      // acquire locks in one global order and merely wait on each other. This
      // property drives concurrent same-slot batches in forward and reversed
      // input orders; without deterministic ordering it deadlocks reliably.
      const fixture = postgresStoreFixture();
      const store = fixture.postgresStore;
      t.after(() => fixture.cleanup());
      const write = (
        data: {
          id: string;
          vary: NormalizedVary<{}>;
          content: { i: number; padding: string };
          directives: { freshUntilAge: number };
        }[],
      ) =>
        store.store(
          data.map((entry) => ({
            entry: {
              ...entry,
              directives: normalizeProducerDirectives(entry.directives),
              validators: {},
              date: new Date(),
              initialAge: 0,
            },
            maxStoreForSeconds: 60,
          })),
        );

      await fc.assert(
        fc.asyncProperty(
          fc.record({
            runId: fc.uuid(),
            slotCount: fc.integer({ min: 60, max: 120 }),
          }),
          async ({ runId, slotCount }) => {
            const data = Array.from({ length: slotCount }, (_unused, i) => ({
              id: `${runId}:${String(i)}`,
              vary: emptyVary,
              // A non-trivial payload keeps each row's processing from being
              // instantaneous, widening the window in which the concurrent
              // statements actually interleave.
              content: { i, padding: "x".repeat(2048) },
              directives: { freshUntilAge: 60 },
            }));

            // Seed the slots so the concurrent calls below take the
            // row-UPDATE (lock-then-wait) path on every slot.
            await write(data);

            const reversed = data.toReversed();
            const results = await Promise.allSettled([
              write(data),
              write(reversed),
              write(data),
              write(reversed),
            ]);
            // Surface the rejection reasons (e.g. "deadlock detected") in the
            // assertion diff, rather than an opaque `{ status: 'rejected' }`.
            const failures = results.flatMap((r) =>
              r.status === "rejected" ? [String(r.reason)] : [],
            );
            assert.deepEqual(failures, []);
          },
        ),
        // Each run is expensive (hundreds of rows across 5 statements), and a
        // single run of ~100 reversed-order rows already reproduces the
        // deadlock essentially every time when ordering is nondeterministic.
        // Skip shrinking: a deadlock is binary and shrinking would rerun many
        // ~1s deadlock_timeout cycles.
        { numRuns: 3, endOnFailure: true },
      );
    });
  },
);
