import { expect } from "chai";
import { describe, it } from "node:test";

import type { ProducerDirectives } from "../types/index.js";
import { normalizeProducerDirectives } from "./normalization.js";

describe("normalizeProducerDirectives", () => {
  describe("freshUntilAge", () => {
    it("throws on NaN, since the directive is required and has no safe default", () => {
      expect(() =>
        normalizeProducerDirectives({ freshUntilAge: NaN }),
      ).to.throw(TypeError, /freshUntilAge.*NaN/);
    });

    it("clamps -Infinity to 0", () => {
      expect(
        normalizeProducerDirectives({ freshUntilAge: -Infinity }).freshUntilAge,
      ).to.equal(0);
    });

    it("preserves +Infinity (means never expires)", () => {
      expect(
        normalizeProducerDirectives({ freshUntilAge: Infinity }).freshUntilAge,
      ).to.equal(Infinity);
    });

    it("clamps negative finite values to 0", () => {
      expect(
        normalizeProducerDirectives({ freshUntilAge: -10 }).freshUntilAge,
      ).to.equal(0);
    });
  });

  describe("storeFor", () => {
    it("drops NaN", () => {
      const result = normalizeProducerDirectives({
        freshUntilAge: 60,
        storeFor: NaN,
      });
      expect(result).to.not.have.property("storeFor");
    });

    it("clamps -Infinity to 0", () => {
      const result = normalizeProducerDirectives({
        freshUntilAge: 60,
        storeFor: -Infinity,
      });
      expect(result.storeFor).to.equal(0);
    });

    it("preserves +Infinity", () => {
      const result = normalizeProducerDirectives({
        freshUntilAge: 60,
        storeFor: Infinity,
      });
      expect(result.storeFor).to.equal(Infinity);
    });

    it("leaves the field absent when not provided", () => {
      const result = normalizeProducerDirectives({ freshUntilAge: 60 });
      expect(result).to.not.have.property("storeFor");
    });
  });

  describe("maxStale", () => {
    const directivesWithMaxStale = (
      maxStale: NonNullable<ProducerDirectives["maxStale"]>,
    ): ProducerDirectives => ({ freshUntilAge: 60, maxStale });

    it("drops the whole maxStale object if any threshold is NaN", () => {
      for (const badField of [
        "withoutRevalidation",
        "whileRevalidate",
        "ifError",
      ] as const) {
        const maxStale = {
          withoutRevalidation: 1,
          whileRevalidate: 2,
          ifError: 3,
          [badField]: NaN,
        };
        const result = normalizeProducerDirectives(
          directivesWithMaxStale(maxStale),
        );
        expect(
          result,
          `expected maxStale dropped when ${badField} is NaN`,
        ).to.not.have.property("maxStale");
      }
    });

    it("preserves Infinity values across all thresholds", () => {
      const result = normalizeProducerDirectives(
        directivesWithMaxStale({
          withoutRevalidation: Infinity,
          whileRevalidate: Infinity,
          ifError: Infinity,
        }),
      );
      expect(result.maxStale).to.deep.equal({
        withoutRevalidation: Infinity,
        whileRevalidate: Infinity,
        ifError: Infinity,
      });
    });

    it("normalizes finite values", () => {
      const result = normalizeProducerDirectives(
        directivesWithMaxStale({
          withoutRevalidation: 10,
          whileRevalidate: 5, // below withoutRevalidation; should be clamped up
          ifError: 30,
        }),
      );
      expect(result.maxStale).to.deep.equal({
        withoutRevalidation: 10,
        whileRevalidate: 10,
        ifError: 30,
      });
    });
  });
});
