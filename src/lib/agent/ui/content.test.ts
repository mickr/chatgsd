import { describe, expect, it } from "vitest";
import { renderableSpec, splitReply } from "./content";

const ROOT = '{"op":"add","path":"/root","value":"t"}';
const TABLE =
  '{"op":"add","path":"/elements/t","value":{"type":"Table","props":{"columns":["Option"],"rows":[["Train"]]},"children":[]}}';
const REPLY = ["Two ways to get there.", "```spec", ROOT, TABLE, "```", "Pick one."].join("\n");

describe("splitReply", () => {
  it("keeps prose and spec blocks in their original order", () => {
    const segments = splitReply(REPLY, false);
    expect(segments.map((segment) => segment.type)).toEqual(["text", "spec", "text"]);
    const [, spec] = segments;
    expect(spec.type === "spec" && renderableSpec(spec.spec)).toBeTruthy();
  });

  it("renders what has arrived of an unclosed block while streaming", () => {
    const partial = ["Two ways to get there.", "```spec", ROOT, TABLE].join("\n");
    const segments = splitReply(`${partial}\n{"op":"add","pa`, true);
    const spec = segments[1];
    expect(spec).toMatchObject({ type: "spec", complete: false });
    expect(spec.type === "spec" && Object.keys(spec.spec.elements)).toEqual(["t"]);
  });

  it("leaves ordinary code fences as prose", () => {
    const segments = splitReply("Run:\n```sh\nnpm test\n```", false);
    expect(segments).toEqual([{ type: "text", text: "Run:\n```sh\nnpm test\n```" }]);
  });
});

describe("renderableSpec", () => {
  it("rejects unknown components and specs without a root element", () => {
    const unknown = {
      root: "x",
      elements: { x: { type: "Script", props: {}, children: [] } },
    };
    expect(renderableSpec(unknown)).toBeNull();
    expect(renderableSpec({ root: "missing", elements: {} })).toBeNull();
    expect(renderableSpec(null)).toBeNull();
  });
});
