import { describe, expect, it } from "vitest";
import { inlineDiff } from "./inlineDiff";

const join = (diff: ReturnType<typeof inlineDiff>, side: "removed" | "added") =>
  diff.prefix + diff[side] + diff.suffix;

describe("inlineDiff", () => {
  it("marks only the words that changed", () => {
    expect(inlineDiff("Rain jacket", "Rain jacket and umbrella")).toEqual({
      prefix: "Rain jacket",
      removed: "",
      added: " and umbrella",
      suffix: "",
    });
    expect(inlineDiff("Leave Friday at 9am", "Leave Sunday at 9am")).toEqual({
      prefix: "Leave ",
      removed: "Friday",
      added: "Sunday",
      suffix: " at 9am",
    });
  });

  it("always rebuilds both sides exactly, including repeated words and newlines", () => {
    for (const [before, after] of [
      ["a a a", "a a"],
      ["- one\n- two\n", "- one\n- two\n- three\n"],
      ["same", "same"],
      ["", "new text"],
    ]) {
      const diff = inlineDiff(before, after);
      expect(join(diff, "removed")).toBe(before);
      expect(join(diff, "added")).toBe(after);
    }
  });
});
