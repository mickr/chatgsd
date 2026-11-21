import type { Editor } from "@tiptap/core";
import type { Spec } from "@json-render/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { setChangeMeta } from "../../components/editor/AgentChanges";
import { citedEntry, findPriorStepAnswer, type PriorMemoryChoice, type ProvenanceEntry } from "./provenance";
import { renderableSpec } from "./ui/content";
import { traceViewTypes } from "./ui/catalog";

export interface WritingSource { title: string; url: string; excerpt: string }
export type TraceRole = "supports" | "tensions";
/**
 * One step of the reasoning that led to an offer: a passage and what the agent
 * took from it. source is null for the open note, or the id of a ledger entry.
 * leads_to is the 1-based later step it feeds into, or null when it converges
 * directly into the offer's outcome/decision (omitted means sequential).
 */
export interface WritingTraceStep {
  quote: string;
  reading: string;
  sure: boolean;
  source?: string | null;
  leads_to?: number | null;
  role?: TraceRole;
}
interface OfferBase {
  quote: string;
  explanation: string;
  replacement: string | null;
  alternative?: string | null;
  question: string | null;
  destination: string | null;
  trace: WritingTraceStep[];
  /** Optional custom GenUI layout grouping converging trace branches. */
  view?: Spec | null;
  sources: WritingSource[];
  /** Short answers the writer can pick for a question; absent when there are none. */
  options?: string[];
}
export type WritingOffer = OfferBase & (
  | { kind: "rewrite"; replacement: string; question: null; destination: null }
  | { kind: "question"; replacement: null; question: string; destination: null }
  | { kind: "evidence"; replacement: null; question: null; destination: null }
  | { kind: "move"; replacement: null; question: null; destination: string }
);
/** realign: the writer corrected one step of a trace and asked the agent to think again.
 * outcome: the writer highlighted a passage to work back from to how it got there.
 * chat: the main conversation drew or updated an argument map directly. */
export type WritingRequest = WritingOffer["kind"] | "compare" | "readback" | "realign" | "outcome" | "chat";
export interface WritingRange { from: number; to: number }
export interface PreparedWritingOffer {
  offer: WritingOffer;
  noteId: string;
  documentSession: number;
  /** Exact text positions, suitable for a highlight or replacement. */
  source: WritingRange;
  requested?: WritingRequest;
  previewContext?: { before: string; after: string; following: string };
  /** Whole node positions, suitable for the companion cursor. */
  sourceBlock: WritingRange;
  destination: WritingRange | null;
  /** Each trace step's text in the note, or null for a step with no place there: a ledger step, or a passage since removed. */
  trace: (WritingRange | null)[];
  /** Note steps whose passage the writer has changed since the map was made; absent when none has. */
  edited?: boolean[];
  /** The note steps' whole nodes, in order, for the companion cursor. */
  traceBlocks: WritingRange[];
  /** Each trace step's ledger entry, or null for a step in the note. */
  provenance: (ProvenanceEntry | null)[];
  /** An earlier answer that may settle each unsure step. A lead shown beside it: the step stays unsure until the writer confirms. */
  resolved?: (ProvenanceEntry | null)[];
  /** Steps explicitly confirmed by the writer on the active card. */
  confirmedSteps?: boolean[];
  /** True when every uncertainty behind an unrequested background question has an earlier answer to point to. */
  suppressedGap?: true;
  /** The ledger the offer was made against, kept so a refresh checks it the same way. */
  ledger?: ProvenanceEntry[];
  /** Saved writer choices checked when reconciling trace uncertainties. */
  memory?: PriorMemoryChoice[];
  /** For an outcome trace, the whole highlight the trace works back from, its opening text and how many paragraphs it spans. */
  outcome?: WritingRange & { text: string; paragraphs: number };
  /** What the writer already answered to this question, on a kept map put back on the note. */
  answered?: string;
}
/** The highlight an outcome trace started from; text is checked when the offer is first prepared. */
export interface WritingOutcome { from: number; to: number; text?: string }

const OFFER_FIELDS = ["kind", "quote", "explanation", "replacement", "question", "destination", "trace", "sources"];
const MAX_PASSAGE = 6000;

function object(value: unknown, fields: string[], label: string, optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const result = value as Record<string, unknown>;
  const required = Object.keys(result).filter(key => !optional.includes(key));
  if (required.length !== fields.length || fields.some(field => !Object.prototype.hasOwnProperty.call(result, field)))
    throw new Error(`${label} has missing or unexpected fields.`);
  return result;
}

function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label} must contain between 1 and ${max} characters.`);
  return value;
}

function replacementText(value: unknown): string {
  const result = text(value, MAX_PASSAGE, "The proposed rewrite");
  if (/[\r\n]/.test(result)) throw new Error("Keep this rewrite within one paragraph.");
  return result;
}

const MAX_OPTIONS = 4;
export const MAX_TRACE = 7;
const MAX_OPTION_CHARS = 120;
const MAX_VIEW_ELEMENTS = 64;

/** 0-based target node for a trace step: a later step index, or `trace.length` for the outcome diamond. */
export function stepTargetIndex(trace: readonly { leads_to?: number | null }[], index: number): number {
  const raw = trace[index]?.leads_to;
  if (raw === undefined) return Math.min(index + 1, trace.length);
  if (raw === null) return trace.length;
  return raw - 1;
}

/** True when independent branches converge or a step pulls in tension, rather than one linear chain. */
export function isConvergentTrace(trace: readonly { leads_to?: number | null; role?: TraceRole }[]): boolean {
  return trace.some((step, index) => stepTargetIndex(trace, index) !== index + 1 || step.role === "tensions");
}

/** Every node index (including `trace.length` for the outcome) on the active step's upstream/downstream branch. */
export function traceActivePath(trace: readonly { leads_to?: number | null }[], active: number | null): Set<number> {
  const path = new Set<number>();
  if (active === null || active < 0 || active > trace.length) return path;
  if (active === trace.length) {
    path.add(trace.length);
    return path;
  }
  path.add(active);
  // First collect upstream premises that feed into `active` itself (not into downstream merge nodes).
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < active; index++) {
      if (!path.has(index) && path.has(stepTargetIndex(trace, index))) {
        path.add(index);
        changed = true;
      }
    }
  }
  // Then follow `active` downstream to the outcome diamond.
  let curr = active;
  const guard = trace.length + 1;
  for (let hops = 0; hops < guard && curr <= trace.length; hops++) {
    path.add(curr);
    if (curr === trace.length) break;
    curr = stepTargetIndex(trace, curr);
  }
  return path;
}

export interface TraceBranchSegment {
  /** Ordered 0-based step indices along this unbranched thread. */
  steps: number[];
  /** 0-based merge target (`< trace.length` for a synthesis step, or `trace.length` for the outcome). */
  mergesInto: number;
  /** True when this segment starts at a synthesis step where earlier branches converged. */
  synthesis: boolean;
  /** True when any step in this segment pulls in tension. */
  tensions: boolean;
}

/** Partitions any convergent trace tree into clean topological branch threads and synthesis nodes. */
export function traceBranches(trace: readonly { leads_to?: number | null; role?: TraceRole }[]): TraceBranchSegment[] {
  const n = trace.length;
  if (!n) return [];
  const inDegree = new Array<number>(n + 1).fill(0);
  const children: number[][] = Array.from({ length: n + 1 }, () => []);
  for (let index = 0; index < n; index++) {
    const target = stepTargetIndex(trace, index);
    inDegree[target]++;
    children[target].push(index);
  }
  const minLeaf = new Array<number>(n + 1).fill(n);
  for (let node = 0; node <= n; node++) {
    if (!children[node].length) { minLeaf[node] = node; continue; }
    children[node].sort((a, b) => minLeaf[a] - minLeaf[b]);
    minLeaf[node] = Math.min(node, ...children[node].map(child => minLeaf[child]));
  }
  const segments: TraceBranchSegment[] = [];
  const collect = (node: number) => {
    for (const child of children[node]) {
      // Walk backward up a single-child chain to find where this unbranched segment begins.
      const chain = [child];
      let head = child;
      while (inDegree[head] === 1) {
        const only = children[head][0];
        chain.unshift(only);
        head = only;
      }
      if (inDegree[head] > 1) collect(head);
      segments.push({
        steps: chain,
        mergesInto: node,
        synthesis: inDegree[head] > 1,
        tensions: chain.some(step => trace[step]?.role === "tensions"),
      });
    }
  };
  collect(n);
  return segments;
}

/** Branch-by-branch playback order ending at `trace.length` (the outcome diamond). */
export function tracePlaybackOrder(trace: readonly { leads_to?: number | null; role?: TraceRole }[]): number[] {
  const order: number[] = [];
  for (const segment of traceBranches(trace)) order.push(...segment.steps);
  order.push(trace.length);
  return order;
}

function parseTraceView(candidate: unknown, traceLength: number): Spec | null {
  if (candidate == null) return null;
  if (typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error("The trace view must be a spec object or null.");
  const spec = renderableSpec({ state: {}, ...(candidate as Record<string, unknown>) });
  if (!spec) return null;
  const entries = Object.entries(spec.elements);
  if (!traceLength || entries.length > MAX_VIEW_ELEMENTS || entries.some(([, el]) => !traceViewTypes.has(el.type)))
    return null;
  for (const [, el] of entries) {
    if (el.type === "TraceStep") {
      const step = el.props.step;
      if (typeof step !== "number" || !Number.isInteger(step) || step < 1 || step > traceLength) return null;
    }
  }
  return spec;
}

function parseOffer(args: unknown): WritingOffer {
  // Suggested answers and custom views are optional: most offers have none.
  const input = object(args, OFFER_FIELDS, "The writing offer", ["options", "alternative", "view"]);
  const suggested = input.options ?? [];
  if (!["rewrite", "question", "evidence", "move"].includes(input.kind as string))
    throw new Error("Unknown writing offer kind.");
  const kind = input.kind as WritingOffer["kind"];
  const quote = text(input.quote, MAX_PASSAGE, "The quoted passage");
  const explanation = text(input.explanation, 1200, "The explanation");
  const replacement = kind === "rewrite" ? replacementText(input.replacement) : null;
  const alternative = input.alternative == null ? null : replacementText(input.alternative);
  if (alternative && (kind !== "rewrite" || alternative === replacement || alternative === quote))
    throw new Error("Use a distinct second version only for a rewrite.");
  const question = kind === "question" ? text(input.question, 1000, "The question") : null;
  const destination = kind === "move" ? text(input.destination, MAX_PASSAGE, "The destination paragraph") : null;
  if ((kind !== "rewrite" && input.replacement !== null) || (kind !== "question" && input.question !== null) ||
      (kind !== "move" && input.destination !== null)) throw new Error("The writing offer mixes incompatible actions.");
  if (!Array.isArray(input.trace) || input.trace.length > MAX_TRACE)
    throw new Error(`Trace the reasoning in at most ${MAX_TRACE} steps.`);
  const rawTrace = input.trace;
  const trace = rawTrace.map((value, index) => {
    const step = object(value, ["quote", "reading", "sure"], "A trace step", ["source", "leads_to", "role"]);
    if (typeof step.sure !== "boolean") throw new Error("A trace step's sure must be true or false.");
    if (step.source != null && typeof step.source !== "string") throw new Error("A trace step's source must be a ledger id or null.");
    if (step.leads_to !== undefined && step.leads_to !== null) {
      if (typeof step.leads_to !== "number" || !Number.isInteger(step.leads_to) ||
          step.leads_to <= index + 1 || step.leads_to > rawTrace.length)
        throw new Error("A trace step's leads_to must be a later 1-based step number or null for the outcome.");
    }
    if (step.role !== undefined && step.role !== null && step.role !== "supports" && step.role !== "tensions")
      throw new Error("A trace step's role must be supports, tensions, or null.");
    return {
      quote: text(step.quote, MAX_PASSAGE, "A traced passage"),
      reading: text(step.reading, 400, "A trace step's reading").trim(),
      sure: step.sure,
      ...(step.source ? { source: step.source as string } : {}),
      ...(step.leads_to !== undefined ? { leads_to: step.leads_to as number | null } : {}),
      ...(step.role === "tensions" ? { role: "tensions" as const } : {}),
    };
  });
  const view = parseTraceView(input.view, trace.length);
  if (!Array.isArray(input.sources) || input.sources.length > 3 ||
      (kind === "evidence" ? !input.sources.length : input.sources.length))
    throw new Error("An evidence offer needs one to three sources; other offers cannot include sources.");
  const sources = input.sources.map(value => {
    const source = object(value, ["title", "url", "excerpt"], "A source");
    const url = text(source.url, 2048, "The source URL");
    let address: URL;
    try { address = new URL(url); } catch { throw new Error("The source URL is invalid."); }
    if (!["http:", "https:"].includes(address.protocol) || address.username || address.password)
      throw new Error("Sources must use an HTTP or HTTPS link without credentials.");
    return { title: text(source.title, 300, "The source title"), url, excerpt: text(source.excerpt, 2000, "The source excerpt") };
  });
  if (!Array.isArray(suggested) || suggested.length > MAX_OPTIONS || (kind !== "question" && suggested.length))
    throw new Error("Only a question may suggest up to four answers.");
  const options = suggested.map(value => text(value, MAX_OPTION_CHARS, "A suggested answer").trim());
  return { kind, quote, explanation, replacement, question, destination, trace, sources,
    ...(view ? { view } : {}), ...(alternative ? { alternative } : {}), ...(options.length ? { options } : {}) } as WritingOffer;
}

interface LocatedPassage { text: WritingRange; block: WritingRange; node: ProseMirrorNode; topLevel: boolean }

/** Why a quote has no single place in the note. The message is written for the agent that quoted it. */
export class PassageError extends Error {
  constructor(readonly reason: "missing" | "ambiguous" | "unsupported", message: string) { super(message); }
}

/**
 * A block's stretches of plain text, each with where it starts. A link to another
 * note or a line break ends one stretch and starts the next; within a stretch,
 * UTF-16 offsets are ProseMirror positions.
 */
function textRuns(node: ProseMirrorNode, pos: number): { text: string; from: number }[] {
  const runs: { text: string; from: number }[] = [];
  let open = false;
  node.forEach((child, offset) => {
    if (!child.isText) { open = false; return; }
    if (!open) runs.push({ text: "", from: pos + 1 + offset });
    open = true;
    runs[runs.length - 1].text += child.text;
  });
  return runs;
}

/** The one place a quote sits in the note, within one stretch of plain text. */
function locate(doc: ProseMirrorNode, quote: string): LocatedPassage {
  const matches: LocatedPassage[] = [];
  let unsupported = false;
  doc.descendants((node, pos, parent) => {
    if (!node.isTextblock) return;
    const runs = textRuns(node, pos);
    let found = false;
    for (const run of runs) {
      for (let offset = run.text.indexOf(quote); offset !== -1; offset = run.text.indexOf(quote, offset + 1)) {
        found = true;
        matches.push({ text: { from: run.from + offset, to: run.from + offset + quote.length },
          block: { from: pos, to: pos + node.nodeSize }, node, topLevel: parent === doc });
        if (matches.length > 1) return false;
      }
    }
    // Only a quote that runs across a link or a line break is out of reach, not everything else in its paragraph.
    const plain = (runs[0]?.text.length ?? 0) === node.content.size;
    if (!found && !plain && node.textContent.includes(quote)) unsupported = true;
    return false;
  });
  if (unsupported) throw new PassageError("unsupported", "That passage includes non-text content. Choose a plain text passage.");
  if (matches.length !== 1) throw matches.length
    ? new PassageError("ambiguous", "That passage appears more than once. Quote enough text to identify it uniquely.")
    : new PassageError("missing", "That passage has changed or is not a single text passage. Ask for a fresh suggestion.");
  return matches[0];
}

/**
 * The highlight still where it was, holding the text it held when the trace was
 * asked for. A highlight that has moved or gone ends the map at the offer's own passage.
 */
function outcomeRange(doc: ProseMirrorNode, outcome?: WritingOutcome): { outcome: NonNullable<PreparedWritingOffer["outcome"]> } | null {
  if (!outcome || outcome.from < 0 || outcome.to > doc.content.size || outcome.from >= outcome.to) return null;
  const text = doc.textBetween(outcome.from, outcome.to, "\n").trim();
  // The request sends at most the highlight's opening, so that is what is checked.
  if (!text || (outcome.text !== undefined && !text.startsWith(outcome.text.trim()))) return null;
  let paragraphs = 0;
  doc.nodesBetween(outcome.from, outcome.to, node => {
    if (node.isTextblock) { paragraphs++; return false; }
  });
  return { outcome: { from: outcome.from, to: outcome.to, text: text.slice(0, 4000), paragraphs: Math.max(1, paragraphs) } };
}

function tryLocate(doc: ProseMirrorNode, quote: string): LocatedPassage | null {
  try { return locate(doc, quote); } catch { return null; }
}

/**
 * A carried range that still holds text, with its block; otherwise nothing. A
 * passage the writer split in two keeps the part in its first paragraph.
 */
function passageAt(doc: ProseMirrorNode, range: WritingRange | null): Pick<LocatedPassage, "text" | "block"> | null {
  if (!range || range.from < 0 || range.to > doc.content.size || range.from >= range.to) return null;
  const $from = doc.resolve(range.from);
  if (!$from.parent.isTextblock) return null;
  const to = Math.min(range.to, $from.end());
  if (to <= range.from) return null;
  return { text: { from: range.from, to }, block: { from: $from.before(), to: $from.after() } };
}

/** Where an existing map has a note step now; null when it has no place to carry and the step is looked for by its words. */
export type StepRelocation = (index: number) => WritingRange | null;

/** An edit that just happened: how positions moved, and the document it left. */
export interface AppliedEdit { mapping: { map: (pos: number, assoc?: number) => number }; doc: ProseMirrorNode }

/**
 * Finds a highlight again by its text, for a kept map going back on the note:
 * the range that text spans, or null unless the note holds it exactly once.
 */
export function locateOutcome(doc: ProseMirrorNode, text: string): WritingOutcome | null {
  const blocks: { start: number; at: number; node: ProseMirrorNode }[] = [];
  let flat = "";
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    if (blocks.length) flat += "\n";
    blocks.push({ start: flat.length, at: pos + 1, node });
    node.forEach(child => { if (child.isText) flat += child.text; });
    return false;
  });
  const found = text ? flat.indexOf(text) : -1;
  if (found < 0 || flat.indexOf(text, found + 1) >= 0) return null;
  const position = (offset: number, end: boolean) => {
    let block = blocks[0];
    for (const candidate of blocks) {
      if (candidate.start > offset) break;
      block = candidate;
    }
    let left = offset - block.start;
    let result = block.at;
    block.node.forEach((child, childOffset) => {
      if (left < 0 || !child.isText) return;
      const size = child.text!.length;
      if (left < size || (end && left === size)) { result = block.at + childOffset + left; left = -1; }
      else left -= size;
    });
    return result;
  };
  return { from: position(found, false), to: position(found + text.length, true), text };
}

/** Locate a unique plain-text quote in the document, or null when absent or ambiguous. */
export function locateQuoteRange(doc: ProseMirrorNode, quote: string): WritingRange | null {
  return tryLocate(doc, quote)?.text ?? null;
}

/** Memory can refer to a passage without moving either caret. */
export function validateMemoryAnchor(editor: Editor, quote: unknown): void {
  locate(editor.state.doc, text(quote, 500, "The memory anchor"));
}

/**
 * Checks an offer against the note and anchors it there. Preparing is read-only:
 * it cannot select, focus, scroll, or edit the note. A fresh offer must quote
 * every note step exactly. With relocate, a map that already exists keeps a step
 * whose passage has since changed, marked as edited, instead of failing.
 */
export function prepareWritingOffer(editor: Editor, args: unknown, requested?: WritingRequest,
  ledger?: ProvenanceEntry[], outcome?: WritingOutcome, memory?: readonly PriorMemoryChoice[],
  relocate?: StepRelocation): PreparedWritingOffer {
  return prepareIn(editor.state.doc, editor, args, requested, ledger, outcome, memory, relocate);
}

/** prepareWritingOffer against a given document: the live one, or the one a particular edit left. */
function prepareIn(doc: ProseMirrorNode, editor: Editor, args: unknown, requested?: WritingRequest,
  ledger?: ProvenanceEntry[], outcome?: WritingOutcome, memory?: readonly PriorMemoryChoice[],
  relocate?: StepRelocation): PreparedWritingOffer {
  const scope = editor.storage.scratchDocument;
  if (editor.isDestroyed || !scope?.noteId) throw new Error("Open a note before reviewing a writing offer.");
  const offer = parseOffer(args);
  if (requested === "compare" && (offer.kind !== "rewrite" || !offer.alternative || offer.replacement === offer.quote))
    throw new Error("The writer requested two distinct rewrites. Provide both replacement and alternative for this passage.");
  if (requested === "readback" && offer.kind !== "question")
    throw new Error("Give the reader’s takeaway in a question card anchored to this passage.");
  const source = locate(doc, offer.quote);
  let destination: WritingRange | null = null;
  if (offer.kind === "move") {
    const target = locate(doc, offer.destination);
    if (!source.topLevel || source.node.type.name !== "paragraph" || source.node.textContent !== offer.quote ||
        !target.topLevel || target.node.type.name !== "paragraph" || target.node.textContent !== offer.destination)
      throw new Error("Move previews need two complete top-level paragraphs.");
    if (target.block.from >= source.block.from) throw new Error("Choose an earlier paragraph as the move destination.");
    destination = target.block;
  }
  const provenance = offer.trace.map(step => step.source ? citedEntry(ledger ?? [], step.source, step.quote) : null);
  // A step from the conversation is also anchored in the note when its text is there, like a sentence an edit wrote.
  const edited = offer.trace.map(() => false);
  const trace = offer.trace.map((step, index) => {
    if (provenance[index]) return tryLocate(doc, step.quote);
    if (!relocate) return locate(doc, step.quote);
    // A step is the place it was drawn at, wherever else its words turn up. Only a step with no place is searched for.
    const found = passageAt(doc, relocate(index)) ?? tryLocate(doc, step.quote);
    edited[index] = !found || doc.textBetween(found.text.from, found.text.to) !== step.quote;
    return found;
  });
  // Word overlap can find an earlier answer but cannot tell that it settles the step, so the step stays unsure.
  const resolved = (ledger?.length || memory?.length)
    ? offer.trace.map((step, index) => step.sure || provenance[index] ? null : findPriorStepAnswer(step, ledger, memory))
    : undefined;
  const hasResolved = !!resolved?.some(Boolean);
  const unsure = offer.trace.flatMap((step, index) => step.sure ? [] : [index]);
  const suppressedGap = !requested && offer.kind === "question" && (
    unsure.length
      ? unsure.every(index => !!resolved?.[index])
      : !offer.trace.length && !!(ledger?.length || memory?.length) &&
        !!findPriorStepAnswer({ quote: offer.quote, reading: offer.question, sure: false }, ledger, memory)
  );
  const inner = { from: source.block.from + 1, to: source.block.to - 1 };
  const previewContext = offer.alternative ? {
    before: doc.textBetween(Math.max(inner.from, source.text.from - 350), source.text.from),
    after: doc.textBetween(source.text.to, Math.min(inner.to, source.text.to + 350)),
    following: doc.nodeAt(source.block.to)?.textContent.slice(0, 350) ?? "",
  } : undefined;
  return { offer, requested, previewContext, noteId: scope.noteId, documentSession: scope.session, source: source.text,
    sourceBlock: source.block, destination, trace: trace.map(item => item?.text ?? null),
    traceBlocks: trace.flatMap(item => item ? [item.block] : []), provenance,
    ...(edited.some(Boolean) ? { edited } : {}),
    ...(hasResolved ? { resolved } : {}),
    ...(suppressedGap ? { suppressedGap: true as const } : {}),
    ...(ledger ? { ledger } : {}),
    ...(memory?.length ? { memory: [...memory] } : {}),
    ...(outcomeRange(doc, outcome) ?? {}) };
}

/**
 * Unrelated typing can move anchors; a changed or ambiguous offer passage
 * invalidates the offer. Given the edit that just happened, each map step follows
 * its own place through it, and is marked as edited when its words there changed.
 * The check runs against the document that edit left, so edits can be followed
 * one at a time even when a later one has already landed.
 */
export function refreshWritingOffer(editor: Editor, prepared: PreparedWritingOffer, edit?: AppliedEdit): PreparedWritingOffer | null {
  const scope = editor.storage.scratchDocument;
  if (editor.isDestroyed || scope?.noteId !== prepared.noteId || scope?.session !== prepared.documentSession) return null;
  const doc = edit?.doc ?? editor.state.doc;
  // The highlight was checked when the offer was made; the writer may since have edited inside it.
  const outcome = prepared.outcome && { from: prepared.outcome.from, to: prepared.outcome.to };
  const carried: StepRelocation = index => {
    const range = prepared.trace[index];
    if (!range) return null;
    if (edit) return { from: edit.mapping.map(range.from, 1), to: edit.mapping.map(range.to, -1) };
    // With no edit to follow, a place is trusted while it still holds the step's words, or once the step is marked
    // edited: that range has followed every edit so far. Otherwise the positions may be old, and the words are searched for.
    const holds = range.to <= doc.content.size && doc.textBetween(range.from, range.to) === prepared.offer.trace[index].quote;
    return holds || prepared.edited?.[index] ? range : null;
  };
  try {
    const refreshed = prepareIn(doc, editor, prepared.offer, prepared.requested, prepared.ledger, outcome, prepared.memory, carried);
    return { ...refreshed,
      ...(prepared.confirmedSteps ? { confirmedSteps: prepared.confirmedSteps } : {}),
      ...(prepared.answered ? { answered: prepared.answered } : {}) };
  } catch { return null; }
}

/**
 * The block the cursor reads beside for one map step: the step's own passage, or
 * for a step only in the conversation, the next passage its branch leads to, and
 * for the outcome, the passage the offer is about.
 */
export function mapStepBlock(doc: ProseMirrorNode, prepared: PreparedWritingOffer, active: number | null): WritingRange {
  const n = prepared.trace.length;
  let curr = active ?? 0;
  for (let hops = 0; hops <= n && curr >= 0 && curr < n; hops++) {
    const range = prepared.trace[curr];
    if (range) {
      const $pos = doc.resolve(range.from);
      return { from: $pos.before($pos.depth), to: $pos.after($pos.depth) };
    }
    curr = stepTargetIndex(prepared.offer.trace, curr);
  }
  return prepared.sourceBlock;
}

/** Longer rewrites are shown first: the writer should read them before they land. */
const DIRECT_REWRITE_CHARS = 400;

/**
 * Whether the agent may make this change itself. Only a short rewrite, and never
 * in text the writer has their cursor or selection in: that sentence is theirs.
 */
export function appliesDirectly(editor: Editor, prepared: PreparedWritingOffer): boolean {
  const { offer, source } = prepared;
  if (offer.kind !== "rewrite" || offer.quote.length > DIRECT_REWRITE_CHARS || offer.replacement.length > DIRECT_REWRITE_CHARS)
    return false;
  // Reasoning that rests on an assumption, or on a passage the writer has changed since, is shown first.
  if (offer.trace.some(step => !step.sure) || prepared.edited?.some(Boolean)) return false;
  const { from, to } = editor.state.selection;
  return to < source.from || from > source.to;
}

/** Human-readable context for a composer draft; this does not request or apply an edit. */
export function writingOfferChatText(prepared: PreparedWritingOffer, draft?: string): string {
  const { offer } = prepared;
  const parts = ["Writing companion suggestion", `Passage:\n${offer.quote}`, offer.explanation];
  if (offer.kind === "rewrite") parts.push(`Proposed wording:\n${draft ?? offer.replacement}`);
  if (offer.kind === "question") {
    parts.push(`Question:\n${offer.question}`);
    if (draft?.trim()) parts.push(`My answer:\n${draft.trim()}`);
  }
  if (offer.kind === "move") parts.push(`Proposed position: before this paragraph:\n${offer.destination}`);
  if (offer.trace.length) {
    const convergent = isConvergentTrace(offer.trace);
    parts.push(`How you got there:\n${offer.trace.map((step, index) => {
      const entry = prepared.provenance[index];
      const target = stepTargetIndex(offer.trace, index);
      const link = convergent ? ` → ${target === offer.trace.length ? "outcome" : `step ${target + 1}`}` : "";
      const role = step.role === "tensions" ? "[tension] " : "";
      return `${index + 1}. ${entry ? `${entry.label}: ` : ""}"${step.quote}"${link}\n${role}${step.sure ? "" : "(unsure) "}${step.reading}`;
    }).join("\n")}`);
  }
  if (offer.kind === "evidence") parts.push(`Sources:\n${offer.sources.map(source =>
    `${source.title}\n${source.url}\n${source.excerpt}`).join("\n\n")}`);
  return parts.join("\n\n");
}

/** Accept exactly the previewed action as one undo event, without stealing focus. */
export function applyWritingOffer(editor: Editor, prepared: PreparedWritingOffer, replacementOverride?: string): void {
  const current = refreshWritingOffer(editor, prepared);
  if (!current) throw new Error("The passage changed. Ask for a fresh suggestion before applying it.");
  if (current.offer.kind !== "rewrite" && current.offer.kind !== "move") throw new Error("This offer does not change the note.");
  const tr = closeHistory(editor.state.tr);
  let arrival: WritingRange;
  if (current.offer.kind === "rewrite") {
    const replacement = replacementText(replacementOverride ?? current.offer.replacement);
    if (replacement === current.offer.quote) return;
    tr.insertText(replacement, current.source.from, current.source.to);
    arrival = { from: current.source.from, to: current.source.from + replacement.length };
  } else {
    if (replacementOverride !== undefined) throw new Error("A paragraph move cannot include a rewrite.");
    const { sourceBlock, destination } = current;
    const node = editor.state.doc.nodeAt(sourceBlock.from)!;
    const selection = editor.state.selection;
    tr.delete(sourceBlock.from, sourceBlock.to).insert(destination!.from, node);
    arrival = { from: destination!.from + 1, to: destination!.from + node.nodeSize - 1 };
    // A caret inside the moved paragraph follows its text; other selections map normally.
    if (selection instanceof TextSelection && selection.from > sourceBlock.from && selection.to < sourceBlock.to) {
      const shift = destination!.from - sourceBlock.from;
      tr.setSelection(TextSelection.create(tr.doc, selection.anchor + shift, selection.head + shift));
    }
  }
  // The document commits atomically; AgentChanges reveals its text at the agent
  // caret without changing the writer's selection or generating typing history.
  const caret = { from: arrival.to, to: arrival.to };
  editor.view.dispatch(setChangeMeta(tr, { source: "agent", presence: { agent: caret }, arrival: [arrival] }));
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false));
}
