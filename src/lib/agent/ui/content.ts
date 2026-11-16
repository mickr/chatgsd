import {
  applySpecPatch,
  parseSpecStreamLine,
  type Spec,
} from "@json-render/core";
import { catalog } from "./catalog";

export type ReplySegment =
  | { type: "text"; text: string }
  | { type: "spec"; spec: Spec; complete: boolean };

const FENCE_OPEN = /^\s*```spec\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;

function emptySpec(): Spec {
  return { root: "", elements: {}, state: {} } as Spec;
}

/**
 * Split an assistant reply into prose and ```spec blocks, in order. Works on
 * partial text while it streams: an unclosed block renders what has arrived,
 * and a half-written last line waits for its newline.
 */
export function splitReply(text: string, streaming: boolean): ReplySegment[] {
  const segments: ReplySegment[] = [];
  const lines = text.split("\n");
  let prose: string[] = [];
  let spec: Spec | null = null;
  const flushProse = () => {
    const joined = prose.join("\n");
    if (joined.trim()) segments.push({ type: "text", text: joined });
    prose = [];
  };
  lines.forEach((line, index) => {
    const isLast = index === lines.length - 1;
    if (!spec) {
      if (FENCE_OPEN.test(line)) {
        flushProse();
        spec = emptySpec();
      } else prose.push(line);
      return;
    }
    if (FENCE_CLOSE.test(line)) {
      segments.push({ type: "spec", spec, complete: true });
      spec = null;
      return;
    }
    if (streaming && isLast) return;
    const patch = parseSpecStreamLine(line);
    if (patch) spec = applySpecPatch(spec, patch);
  });
  if (spec) segments.push({ type: "spec", spec, complete: !streaming });
  flushProse();
  return segments;
}

/** A renderable spec, or null when it's empty or uses unknown components. */
export function renderableSpec(candidate: unknown): Spec | null {
  if (!candidate || typeof candidate !== "object") return null;
  const result = catalog.validate(candidate);
  if (!result.success) return null;
  const spec = result.data as Spec;
  return spec.root && spec.elements[spec.root] ? spec : null;
}
