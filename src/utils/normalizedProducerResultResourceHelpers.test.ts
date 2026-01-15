import { assert, expect } from "chai";
import { omit } from "es-toolkit";
import fc from "fast-check";
import { describe, it } from "node:test";

import {
  AllConsumerDirectivesArb,
  AllNormalizedProducerDirectivesArb,
  AnyNumberArb,
  NormalizedProducerDirectivesArb,
  PositiveNumberArb,
  ProducerDirectivesArb,
} from "../../test/arbitraries/index.js";
import {
  dummyEntryData,
  FreshEntryArb,
  MAX_INITIAL_AGE,
  StaleEntryArb,
} from "../../test/fixtures.js";
import * as sut from "./normalizedProducerResultResourceHelpers.js";

describe("NormalizedProducerResultResourceHelpers", () => {
  describe("#birthDate", () => {
    it("should calculate birth date based on age at time received", () => {
      const calculatedBirthdate = sut.birthDate({
        ...dummyEntryData(),
        initialAge: 120,
        date: new Date("January 2, 2019 00:00 UTC"),
      });

      expect(calculatedBirthdate).to.deep.equal(
        new Date("January 1, 2019 23:58:00 UTC"),
      );
    });
  });

  describe("#age", () => {
    it("should calculate age based correctly", () => {
      const now = new Date();
      const entry = {
        ...dummyEntryData(),
        initialAge: 120,
        date: new Date("February 12, 2014 00:00 UTC"),
      };
      const ageMs = now.valueOf() - sut.birthDate(entry).valueOf();

      expect(sut.age(entry, now)).to.eq(ageMs / 1000);
    });
  });

  describe("classifying an entry's usability", () => {
    // There are 8 possible broad states here:
    //  - there are two relevant consumer directives, maxAge and maxStale,
    //    and the consumer can provide any of the 4 subsets of those:
    //    {}, { maxAge }, { maxStale }, { maxAge, maxStale };
    //  - the producer must provide `freshUntilAge`, so it only has
    //    { freshUntilAge } or { freshUntilAge, maxStale } as its salient
    //    possible directives, making the total # of combinations 4 * 2.
    //
    // - TODO: test `storeFor` elsewhere, as it doesn't effect an entries
    //   usability (if present in the cache), but does effect whether it should
    //   be present in the first palce.

    // This is the simplest case: producer's indicated a freshness lifetime,
    // and neither party has indicated a tolerance for stale resources.
    describe("producer: { freshUntilAge }, consumer: { }", () => {
      it("should mark fresh entries as usable; stale as unusable", () => {
        const fresh = dummyEntryData({ freshUntilAge: 10 }, 0);
        const stale = dummyEntryData({ freshUntilAge: 10 }, 20);
        const consumerDirs = {};
        expect(sut.classify(fresh, consumerDirs, new Date())).to.eq(
          sut.EntryClassification.Usable,
        );

        expect(sut.classify(stale, consumerDirs, new Date())).to.eq(
          sut.EntryClassification.Unusable,
        );
      });
    });

    describe("producer: { freshUntilAge }, consumer: { maxAge }", () => {
      it("should mark entries usable iff fresh and in consumer maxAge; else unusable", () => {
        fc.assert(
          fc.property(
            AnyNumberArb,
            AnyNumberArb,
            AnyNumberArb,
            (freshUntilAge, consumerMaxAge, initialAge) => {
              const entry = dummyEntryData({ freshUntilAge }, initialAge);
              const now = new Date();
              expect(
                sut.classify(entry, { maxAge: consumerMaxAge }, now),
              ).to.eq(
                sut.isFresh(entry, now) && sut.age(entry, now) <= consumerMaxAge
                  ? sut.EntryClassification.Usable
                  : sut.EntryClassification.Unusable,
              );
            },
          ),
        );
      });
    });

    // Consumer's expressed an interest in stale entries, and producer
    // hasn't indicated anything, so consumer's preferences win (a la HTTP).
    describe("producer: { freshUntilAge }, consumer: { maxStale }", () => {
      it("should mark fresh entries usable", () => {
        fc.assert(
          fc.property(AllNormalizedProducerDirectivesArb, (producerDirs) => {
            const { freshUntilAge, maxStale } = producerDirs;
            const initialAge = Math.min(MAX_INITIAL_AGE, freshUntilAge / 2);
            const freshEntry = dummyEntryData({ freshUntilAge }, initialAge);
            const now = new Date();

            expect(sut.classify(freshEntry, { maxStale }, now)).to.eq(
              sut.EntryClassification.Usable,
            );
          }),
        );
      });

      it("should handle stale entries according to consumer's preferences", () => {
        fc.assert(
          fc.property(AllNormalizedProducerDirectivesArb, (producerDirs) => {
            const { freshUntilAge, maxStale } = producerDirs;
            // add 5 to make it stale
            const staleEntry = dummyEntryData(
              { freshUntilAge },
              freshUntilAge + 5,
            );
            const now = new Date();
            const staleBy = sut.age(staleEntry, now) - freshUntilAge;

            expect(sut.classify(staleEntry, { maxStale }, now)).to.eq(
              staleBy <= maxStale.withoutRevalidation
                ? sut.EntryClassification.Usable
                : staleBy <= maxStale.whileRevalidate
                  ? sut.EntryClassification.UsableWhileRevalidate
                  : staleBy <= maxStale.ifError
                    ? sut.EntryClassification.UsableIfError
                    : sut.EntryClassification.Unusable,
            );
          }),
        );
      });
    });

    // This case is just a combination of the prior two, with maxAge
    // being applied first. So, we test it as a combination.
    describe("producer: { freshUntilAge }, consumer: { maxAge, maxStale }", () => {
      it("should be unusable if consumer maxAge exceeded; else, that maxAge should have no effect", () => {
        fc.assert(
          fc.property(
            AnyNumberArb,
            AnyNumberArb,
            AllConsumerDirectivesArb,
            (freshUntilAge, initialAge, consumerDirs) => {
              const now = new Date();
              const entry = dummyEntryData({ freshUntilAge }, initialAge);
              const tooOld = sut.age(entry, now) > consumerDirs.maxAge;

              const res = sut.classify(entry, consumerDirs, now);
              const resWithoutMaxAge = sut.classify(
                entry,
                omit(consumerDirs, ["maxAge"]),
                now,
              );

              expect(res).to.eq(
                tooOld ? sut.EntryClassification.Unusable : resWithoutMaxAge,
              );
            },
          ),
        );
      });
    });

    // Here, fresh results are still usable. Because the consumer hasn't
    // indicated a tolerance for stale responses, stale responses can only
    // be UsableWhileRevalidate or UsableIfError [they can't be plain Usable].
    describe("producer: { freshUntilAge, maxStale? }, consumer: { }", () => {
      it("should mark fresh entries as usable", () => {
        fc.assert(
          fc.property(FreshEntryArb(), (freshEntry) => {
            expect(sut.classify(freshEntry, {}, new Date())).to.eq(
              sut.EntryClassification.Usable,
            );
          }),
        );
      });

      it("should mark stale entries as something besides usable", () => {
        fc.assert(
          fc.property(AllNormalizedProducerDirectivesArb, (producerDirs) => {
            const now = new Date();
            const { freshUntilAge, maxStale } = producerDirs;

            const staleEntry = dummyEntryData(
              producerDirs,
              freshUntilAge + 2,
              now,
            );

            // Don't run the test if the entry's fresh [that's covered above].
            assert(
              !sut.isFresh(staleEntry, now),
              "Thought generated entry was stale",
            );

            const res = sut.classify(staleEntry, {}, now);
            const staleBy = sut.age(staleEntry, now) - freshUntilAge;

            // Result should be UsableWhileRevalidate, UsableIfError,
            // or Unusable, depending on normalized maxStale.
            // We ignore producer's maxStale.withoutRevalidation, since consumer won't accept those.
            expect(res).to.eq(
              staleBy <= maxStale.whileRevalidate
                ? sut.EntryClassification.UsableWhileRevalidate
                : staleBy <= maxStale.ifError
                  ? sut.EntryClassification.UsableIfError
                  : sut.EntryClassification.Unusable,
            );
          }),
        );
      });
    });

    describe("producer: { freshUntilAge, maxStale? }, consumer: { maxAge }", () => {
      it("should mark fresh entries as usable iff in consumer maxAge, else unusable", () => {
        fc.assert(
          fc.property(
            FreshEntryArb(),
            AnyNumberArb,
            (freshEntry, consumerMaxAge) => {
              const now = new Date();
              expect(
                sut.classify(freshEntry, { maxAge: consumerMaxAge }, now),
              ).to.eq(
                sut.age(freshEntry, now) <= consumerMaxAge
                  ? sut.EntryClassification.Usable
                  : sut.EntryClassification.Unusable,
              );
            },
          ),
        );
      });

      it("should mark stale entries outside consumer's maxAge as unusable", () => {
        fc.assert(
          fc.property(
            ProducerDirectivesArb,
            AnyNumberArb,
            (producerDirs, consumerMaxAge) => {
              const now = new Date();
              const tooOldEntry = dummyEntryData(
                producerDirs,
                consumerMaxAge + 10,
              );
              expect(
                sut.classify(tooOldEntry, { maxAge: consumerMaxAge }, now),
              ).to.eq(sut.EntryClassification.Unusable);
            },
          ),
        );
      });

      it("should mark stale entries within the consumer's maxAge according to producer's maxStale", () => {
        // we copy some of the below from the "producer: { maxAge, maxStale }, consumer: {}" test.
        fc.assert(
          fc.property(
            StaleEntryArb,
            PositiveNumberArb,
            (staleEntry, positiveNum) => {
              const now = new Date();

              const age = sut.age(staleEntry, now);
              const consumerMaxAge = age + positiveNum;

              expect(
                sut.classify(staleEntry, { maxAge: consumerMaxAge }, now),
              ).to.eq(sut.classify(staleEntry, {}, now));
            },
          ),
        );
      });
    });

    describe("producer: { freshUntilAge, maxStale? }, consumer: { maxStale }", () => {
      it("should mark entries fresh by both producer and consumer standards as usable", () => {
        fc.assert(
          fc.property(
            NormalizedProducerDirectivesArb,
            AllConsumerDirectivesArb,
            (producerDirs, consumerDirs) => {
              const now = new Date();
              const effectiveFreshUntilAge = Math.min(
                consumerDirs.maxStale?.freshUntilAge ?? MAX_INITIAL_AGE,
                producerDirs.freshUntilAge,
              );

              const freshEntry = dummyEntryData(
                producerDirs,
                Math.min(MAX_INITIAL_AGE, effectiveFreshUntilAge / 2),
              );

              expect(
                sut.classify(
                  freshEntry,
                  { maxStale: consumerDirs.maxStale },
                  now,
                ),
              ).to.eq(sut.EntryClassification.Usable);
            },
          ),
        );
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      it.skip("should reconcile competing maxStales to handle stale entries");
    });

    // Again, this case is just a combination of the prior two, with
    // consumer maxAge being applied first. So, we test it as a combination.
    describe("producer: { freshUntilAge, maxStale? }, consumer: { maxAge, maxStale }", () => {
      it("should be unusable if consumer maxAge exceeded; else, that maxAge should have no effect", () => {
        fc.assert(
          fc.property(
            AnyNumberArb,
            ProducerDirectivesArb,
            AllConsumerDirectivesArb,
            (initialAge, producerDirs, consumerDirs) => {
              const now = new Date();
              const entry = dummyEntryData(producerDirs, initialAge);
              const tooOld = sut.age(entry, now) > consumerDirs.maxAge;

              const res = sut.classify(entry, consumerDirs, now);
              const resWithoutMaxAge = sut.classify(
                entry,
                omit(consumerDirs, ["maxAge"]),
                now,
              );

              expect(res).to.eq(
                tooOld ? sut.EntryClassification.Unusable : resWithoutMaxAge,
              );
            },
          ),
        );
      });
    });

    // Test the consumer's freshUntilAge override
    describe("consumer freshUntilAge override", () => {
      it("should use consumer's freshUntilAge when it's stricter than producer's", () => {
        // Producer says fresh for 100s, consumer says fresh for only 50s
        const entry = dummyEntryData({ freshUntilAge: 100 }, 60); // 60s old
        const now = new Date();

        // Without consumer override: entry is fresh (60 < 100)
        expect(sut.classify(entry, {}, now)).to.eq(
          sut.EntryClassification.Usable,
        );

        // With consumer override to 50s: entry is stale (60 > 50)
        // and without any maxStale tolerance, it's unusable
        expect(
          sut.classify(
            entry,
            {
              maxStale: {
                freshUntilAge: 50,
                withoutRevalidation: 0,
                whileRevalidate: 0,
                ifError: 0,
              },
            },
            now,
          ),
        ).to.eq(sut.EntryClassification.Unusable);

        // With consumer override to 50s and some stale tolerance
        expect(
          sut.classify(
            entry,
            {
              maxStale: {
                freshUntilAge: 50,
                withoutRevalidation: 20,
                whileRevalidate: 20,
                ifError: 20,
              },
            },
            now,
          ),
        ).to.eq(sut.EntryClassification.Usable); // 60-50=10s stale, within 20s tolerance
      });

      it("should ignore consumer's freshUntilAge when it's more permissive than producer's", () => {
        // Producer says fresh for 50s, consumer says fresh for 100s
        const entry = dummyEntryData({ freshUntilAge: 50 }, 60); // 60s old
        const now = new Date();

        // Consumer's 100s is ignored; effective freshness is min(100, 50) = 50s
        // Entry is 60s old, so it's stale by 10s
        // Without any stale tolerance, it's unusable
        expect(
          sut.classify(
            entry,
            {
              maxStale: {
                freshUntilAge: 100,
                withoutRevalidation: 0,
                whileRevalidate: 0,
                ifError: 0,
              },
            },
            now,
          ),
        ).to.eq(sut.EntryClassification.Unusable);
      });
    });
  });
});
