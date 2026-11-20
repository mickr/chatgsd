import type { Spec } from "@json-render/core";
import { previewTypes } from "./catalog";
import { renderableSpec } from "./content";

interface Element {
  type: string;
  props: Record<string, unknown>;
  children: string[];
}
interface Field {
  label: string;
  value: string;
}
interface Call {
  arguments: Record<string, unknown>;
}

const MAX_FIELDS = 80;
const MAX_INLINE_CHARS = 80;
const MAX_TEXT_CHARS = 6000;
const MAX_PREVIEW_ELEMENTS = 80;
const PREVIEW = "preview/";
const CALL = "call";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPlain = (value: unknown) => value === null || typeof value !== "object";
const plain = (value: unknown) => (value === "" ? '""' : String(value));

/** One labelled value per leaf of the arguments, named by its path. */
function flatten(value: unknown, label: string, fields: Field[]) {
  if (Array.isArray(value)) {
    if (value.every(isPlain))
      fields.push({ label, value: value.length ? value.map(plain).join(", ") : "[]" });
    else value.forEach((item, index) => flatten(item, `${label}[${index}]`, fields));
  } else if (isRecord(value)) {
    const entries = Object.entries(value);
    if (!entries.length && label) fields.push({ label, value: "{}" });
    for (const [key, item] of entries) flatten(item, label ? `${label}.${key}` : key, fields);
  } else fields.push({ label, value: plain(value) });
}

function clipped(text: string) {
  const more = text.length - MAX_TEXT_CHARS;
  return more > 0
    ? `${text.slice(0, MAX_TEXT_CHARS)}…\n[${more} more characters are sent and not shown here.]`
    : text;
}

/**
 * The call's arguments exactly as they will be sent, laid out to be read:
 * short values as labelled facts, long ones as text under their name.
 */
function callElements(call: Call): Record<string, Element> {
  const fields: Field[] = [];
  flatten(call.arguments, "", fields);
  const elements: Record<string, Element> = {};
  const children: string[] = [];
  const add = (type: string, props: Record<string, unknown>) => {
    const id = `${CALL}/${children.length}`;
    elements[id] = { type, props, children: [] };
    children.push(id);
  };
  let facts: Field[] = [];
  const flush = () => {
    if (facts.length) add("KeyValue", { items: facts });
    facts = [];
  };
  for (const field of fields.slice(0, MAX_FIELDS)) {
    if (field.value.length <= MAX_INLINE_CHARS && !field.value.includes("\n")) {
      facts.push(field);
      continue;
    }
    flush();
    add("Heading", { text: field.label });
    add("Text", { text: clipped(field.value), tone: null });
  }
  flush();
  if (fields.length > MAX_FIELDS)
    add("Text", {
      text: `${fields.length - MAX_FIELDS} more values are sent and not shown here.`,
      tone: "muted",
    });
  if (!fields.length) add("Text", { text: "Nothing is sent with this call.", tone: "muted" });
  elements[CALL] = { type: "Card", props: { title: "What is sent" }, children };
  return elements;
}

/**
 * The agent's own layout of the call, under IDs that can't collide with the
 * call's. Dropped whole if it is too large or uses anything but display blocks.
 */
function previewElements(candidate: unknown) {
  const spec = renderableSpec(isRecord(candidate) ? { state: {}, ...candidate } : null);
  if (!spec) return null;
  const entries = Object.entries(spec.elements);
  if (
    entries.length > MAX_PREVIEW_ELEMENTS ||
    entries.some(([, element]) => !previewTypes.has(element.type))
  )
    return null;
  const elements = Object.fromEntries(
    entries.map(([id, element]) => [
      PREVIEW + id,
      { ...element, children: (element.children ?? []).map((child) => PREVIEW + child) },
    ]),
  );
  return { root: PREVIEW + spec.root, elements };
}

/**
 * What an `mcp_approval` request shows before its buttons: the exact call,
 * beneath the agent's preview of it when there is one. Null when the request
 * names no call.
 */
export function approvalSpec(request: unknown): Spec | null {
  const input = isRecord(request) ? request : {};
  if (!isRecord(input.call) || !isRecord(input.call.arguments)) return null;
  const call = callElements({ arguments: input.call.arguments });
  const preview = previewElements(input.preview);
  if (!preview) return { root: CALL, elements: call, state: {} } as Spec;
  return {
    root: "approval",
    elements: {
      ...preview.elements,
      ...call,
      approval: {
        type: "Stack",
        props: { direction: null, gap: "md" },
        children: [preview.root, CALL],
      },
    },
    state: {},
  } as Spec;
}
