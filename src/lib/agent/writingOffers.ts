import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { setChangeMeta } from "../../components/editor/AgentChanges";

export interface WritingSource { title: string; url: string; excerpt: string }
interface OfferBase {
  quote: string;
  explanation: string;
  replacement: string | null;
  question: string | null;
  destination: string | null;
  trace: string[];
  sources: WritingSource[];
}
export type WritingOffer = OfferBase & (
  | { kind: "rewrite"; replacement: string; question: null; destination: null }
  | { kind: "question"; replacement: null; question: string; destination: null }
  | { kind: "evidence"; replacement: null; question: null; destination: null }
  | { kind: "move"; replacement: null; question: null; destination: string }
);
export interface WritingRange { from: number; to: number }
export interface PreparedWritingOffer {
  offer: WritingOffer;
  noteId: string;
  documentSession: number;
  /** Exact text positions, suitable for a highlight or replacement. */
  source: WritingRange;
  /** Whole node positions, suitable for the companion cursor. */
  sourceBlock: WritingRange;
  destination: WritingRange | null;
  trace: WritingRange[];
  traceBlocks: WritingRange[];
}

const OFFER_FIELDS = ["kind", "quote", "explanation", "replacement", "question", "destination", "trace", "sources"];
const MAX_PASSAGE = 6000;

function object(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== fields.length || fields.some(field => !Object.prototype.hasOwnProperty.call(result, field)))
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

function parseOffer(args: unknown): WritingOffer {
  const input = object(args, OFFER_FIELDS, "The writing offer");
  if (!["rewrite", "question", "evidence", "move"].includes(input.kind as string))
    throw new Error("Unknown writing offer kind.");
  const kind = input.kind as WritingOffer["kind"];
  const quote = text(input.quote, MAX_PASSAGE, "The quoted passage");
  const explanation = text(input.explanation, 1200, "The explanation");
  const replacement = kind === "rewrite" ? replacementText(input.replacement) : null;
  const question = kind === "question" ? text(input.question, 1000, "The question") : null;
  const destination = kind === "move" ? text(input.destination, MAX_PASSAGE, "The destination paragraph") : null;
  if ((kind !== "rewrite" && input.replacement !== null) || (kind !== "question" && input.question !== null) ||
      (kind !== "move" && input.destination !== null)) throw new Error("The writing offer mixes incompatible actions.");
  if (!Array.isArray(input.trace) || input.trace.length > 3 || (kind !== "question" && input.trace.length))
    throw new Error("Only a question may trace up to three passages.");
  const trace = input.trace.map(value => text(value, MAX_PASSAGE, "A traced passage"));
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
  return { kind, quote, explanation, replacement, question, destination, trace, sources } as WritingOffer;
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

/** Preparing an offer is read-only. It cannot select, focus, scroll, or edit the note. */
export function prepareWritingOffer(editor: Editor, args: unknown): PreparedWritingOffer {
  const scope = editor.storage.scratchDocument;
  if (editor.isDestroyed || !scope?.noteId) throw new Error("Open a note before reviewing a writing offer.");
  const offer = parseOffer(args);
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
  const trace = offer.trace.map(quote => locate(editor.state.doc, quote));
  return { offer, noteId: scope.noteId, documentSession: scope.session, source: source.text,
    sourceBlock: source.block, destination, trace: trace.map(item => item.text), traceBlocks: trace.map(item => item.block) };
}

/** Unrelated typing can move anchors; changed or ambiguous passages invalidate them. */
export function refreshWritingOffer(editor: Editor, prepared: PreparedWritingOffer): PreparedWritingOffer | null {
  const scope = editor.storage.scratchDocument;
  if (editor.isDestroyed || scope?.noteId !== prepared.noteId || scope?.session !== prepared.documentSession) return null;
  try { return prepareWritingOffer(editor, prepared.offer); } catch { return null; }
}

/** Human-readable context for a composer draft; this does not request or apply an edit. */
export function writingOfferChatText(prepared: PreparedWritingOffer, draft?: string): string {
  const { offer } = prepared;
  const parts = ["Writing companion suggestion", `Passage:\n${offer.quote}`, offer.explanation];
  if (offer.kind === "rewrite") parts.push(`Proposed wording:\n${draft ?? offer.replacement}`);
  if (offer.kind === "question") {
    if (offer.trace.length) parts.push(`Argument passages:\n${offer.trace.join("\n\n")}`);
    parts.push(`Question:\n${offer.question}`);
    if (draft?.trim()) parts.push(`My answer:\n${draft.trim()}`);
  }
  if (offer.kind === "move") parts.push(`Proposed position: before this paragraph:\n${offer.destination}`);
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
  editor.view.dispatch(setChangeMeta(tr, { source: "agent", presence: { agent: arrival }, arrival: [arrival] }));
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false));
}
