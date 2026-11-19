import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { setChangeMeta } from "../../components/editor/AgentChanges";
import { citedEntry, type ProvenanceEntry } from "./provenance";

export interface WritingSource { title: string; url: string; excerpt: string }
/**
 * One step of the reasoning that led to an offer: a passage and what the agent
 * took from it. source is null for the open note, or the id of a ledger entry
 * (something the writer said, research, a connected service, another note, an edit).
 */
export interface WritingTraceStep { quote: string; reading: string; sure: boolean; source?: string | null }
interface OfferBase {
  quote: string;
  explanation: string;
  replacement: string | null;
  alternative?: string | null;
  question: string | null;
  destination: string | null;
  trace: WritingTraceStep[];
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
 * outcome: the writer highlighted a passage to work back from to how it got there. */
export type WritingRequest = WritingOffer["kind"] | "compare" | "readback" | "realign" | "outcome";
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
  /** Each trace step's text in the note, or null for a ledger step whose text isn't in the note. */
  trace: (WritingRange | null)[];
  /** The note steps' whole nodes, in order, for the companion cursor. */
  traceBlocks: WritingRange[];
  /** Each trace step's ledger entry, or null for a step in the note. */
  provenance: (ProvenanceEntry | null)[];
  /** The ledger the offer was made against, kept so a refresh checks it the same way. */
  ledger?: ProvenanceEntry[];
  /** For an outcome trace, the whole highlight the trace works back from, its opening text and how many paragraphs it spans. */
  outcome?: WritingRange & { text: string; paragraphs: number };
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
const MAX_TRACE = 5;
const MAX_OPTION_CHARS = 120;

function parseOffer(args: unknown): WritingOffer {
  // Suggested answers are optional: most offers have none.
  const input = object(args, OFFER_FIELDS, "The writing offer", ["options", "alternative"]);
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
  const trace = input.trace.map(value => {
    const step = object(value, ["quote", "reading", "sure"], "A trace step", ["source"]);
    if (typeof step.sure !== "boolean") throw new Error("A trace step's sure must be true or false.");
    if (step.source != null && typeof step.source !== "string") throw new Error("A trace step's source must be a ledger id or null.");
    return { quote: text(step.quote, MAX_PASSAGE, "A traced passage"),
      reading: text(step.reading, 400, "A trace step's reading").trim(), sure: step.sure,
      ...(step.source ? { source: step.source as string } : {}) };
  });
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
    ...(alternative ? { alternative } : {}), ...(options.length ? { options } : {}) } as WritingOffer;
}

interface LocatedPassage { text: WritingRange; block: WritingRange; node: ProseMirrorNode; topLevel: boolean }

/** Text-only inline content keeps UTF-16 offsets identical to ProseMirror positions. */
function locate(doc: ProseMirrorNode, quote: string): LocatedPassage {
  const matches: LocatedPassage[] = [];
  let unsupported = false;
  doc.descendants((node, pos, parent) => {
    if (!node.isTextblock) return;
    let textOnly = true;
    node.forEach(child => { if (!child.isText) textOnly = false; });
    if (!textOnly) {
      if (node.textContent.includes(quote)) unsupported = true;
      return false;
    }
    const content = node.textContent;
    for (let offset = content.indexOf(quote); offset !== -1; offset = content.indexOf(quote, offset + 1)) {
      matches.push({ text: { from: pos + 1 + offset, to: pos + 1 + offset + quote.length },
        block: { from: pos, to: pos + node.nodeSize }, node, topLevel: parent === doc });
      if (matches.length > 1) return false;
    }
    return false;
  });
  if (unsupported) throw new Error("That passage includes non-text content. Choose a plain text passage.");
  if (matches.length !== 1) throw new Error(matches.length
    ? "That passage appears more than once. Quote enough text to identify it uniquely."
    : "That passage has changed or is not a single text passage. Ask for a fresh suggestion.");
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

/** Memory can refer to a passage without moving either caret. */
export function validateMemoryAnchor(editor: Editor, quote: unknown): void {
  locate(editor.state.doc, text(quote, 500, "The memory anchor"));
}

/** Preparing an offer is read-only. It cannot select, focus, scroll, or edit the note. */
export function prepareWritingOffer(editor: Editor, args: unknown, requested?: WritingRequest,
  ledger?: ProvenanceEntry[], outcome?: WritingOutcome): PreparedWritingOffer {
  const scope = editor.storage.scratchDocument;
  if (editor.isDestroyed || !scope?.noteId) throw new Error("Open a note before reviewing a writing offer.");
  const offer = parseOffer(args);
  if (requested === "compare" && (offer.kind !== "rewrite" || !offer.alternative || offer.replacement === offer.quote))
    throw new Error("The writer requested two distinct rewrites. Provide both replacement and alternative for this passage.");
  if (requested === "readback" && offer.kind !== "question")
    throw new Error("Give the reader’s takeaway in a question card anchored to this passage.");
  const source = locate(editor.state.doc, offer.quote);
  let destination: WritingRange | null = null;
  if (offer.kind === "move") {
    const target = locate(editor.state.doc, offer.destination);
    if (!source.topLevel || source.node.type.name !== "paragraph" || source.node.textContent !== offer.quote ||
        !target.topLevel || target.node.type.name !== "paragraph" || target.node.textContent !== offer.destination)
      throw new Error("Move previews need two complete top-level paragraphs.");
    if (target.block.from >= source.block.from) throw new Error("Choose an earlier paragraph as the move destination.");
    destination = target.block;
  }
  const provenance = offer.trace.map(step => step.source ? citedEntry(ledger ?? [], step.source, step.quote) : null);
  // A step from the conversation is also anchored in the note when its text is there, like a sentence an edit wrote.
  const trace = offer.trace.map((step, index) => provenance[index] ? tryLocate(editor.state.doc, step.quote) : locate(editor.state.doc, step.quote));
  const offset = source.text.from - source.block.from - 1;
  const previewContext = offer.alternative ? {
    before: source.node.textContent.slice(Math.max(0, offset - 350), offset),
    after: source.node.textContent.slice(offset + offer.quote.length, offset + offer.quote.length + 350),
    following: editor.state.doc.nodeAt(source.block.to)?.textContent.slice(0, 350) ?? "",
  } : undefined;
  return { offer, requested, previewContext, noteId: scope.noteId, documentSession: scope.session, source: source.text,
    sourceBlock: source.block, destination, trace: trace.map(item => item?.text ?? null),
    traceBlocks: trace.flatMap(item => item ? [item.block] : []), provenance, ...(ledger ? { ledger } : {}),
    ...(outcomeRange(editor.state.doc, outcome) ?? {}) };
}

/** Unrelated typing can move anchors; changed or ambiguous passages invalidate them. */
export function refreshWritingOffer(editor: Editor, prepared: PreparedWritingOffer): PreparedWritingOffer | null {
  const scope = editor.storage.scratchDocument;
  if (editor.isDestroyed || scope?.noteId !== prepared.noteId || scope?.session !== prepared.documentSession) return null;
  // The highlight was checked when the offer was made; the writer may since have edited inside it.
  const outcome = prepared.outcome && { from: prepared.outcome.from, to: prepared.outcome.to };
  try { return prepareWritingOffer(editor, prepared.offer, prepared.requested, prepared.ledger, outcome); } catch { return null; }
}

/**
 * The block the cursor reads beside for one map step: the step's own passage, or
 * for a step only in the conversation, the next passage it leads to, and for the
 * outcome, the passage the offer is about.
 */
export function mapStepBlock(doc: ProseMirrorNode, prepared: PreparedWritingOffer, active: number | null): WritingRange {
  for (let index = active ?? 0; index < prepared.trace.length; index++) {
    const range = prepared.trace[index];
    if (!range) continue;
    const $pos = doc.resolve(range.from);
    return { from: $pos.before($pos.depth), to: $pos.after($pos.depth) };
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
  if (offer.trace.length) parts.push(`How you got there:\n${offer.trace.map((step, index) => {
    const entry = prepared.provenance[index];
    return `${index + 1}. ${entry ? `${entry.label}: ` : ""}"${step.quote}"\n${step.sure ? "" : "(unsure) "}${step.reading}`;
  }).join("\n")}`);
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
