import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideSlot } from "./producerClient.js";

describe("decideSlot", () => {
  const fresh = { name: "fresh" };
  const stale = { name: "stale" };
  const ifError = { name: "if-error" };

  it("fails a slot whose lookup is an Error", () => {
    const error = new Error("read failed");
    assert.deepEqual(decideSlot(error), { action: "fail", error });
  });

  it("serves a usable entry, even when staler entries exist", () => {
    assert.deepEqual(
      decideSlot({
        usable: fresh,
        usableWhileRevalidate: stale,
        usableIfError: ifError,
      }),
      { action: "serve", entry: fresh },
    );
  });

  it("serves a stale-while-revalidate entry and refreshes it", () => {
    assert.deepEqual(
      decideSlot({ usableWhileRevalidate: stale, usableIfError: ifError }),
      { action: "serve-and-refresh", entry: stale },
    );
  });

  it("produces, with the if-error entry as the fallback", () => {
    assert.deepEqual(decideSlot({ usableIfError: ifError }), {
      action: "produce",
      ifError,
    });
  });

  it("produces with no fallback on a miss", () => {
    assert.deepEqual(decideSlot({ usableIfError: undefined }), {
      action: "produce",
      ifError: undefined,
    });
  });
});
