import type { Editor, JSONContent } from "@tiptap/core";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import type { Transaction } from "@tiptap/pm/state";
import {
  agentChangesKey,
  attachedRange,
  detachSelection,
  setChangeMeta,
  type AgentChange,
} from "../../components/editor/AgentChanges";

export interface RunBinding {
  runId: string;
  documentSession: number;
  noteId: string;
  noteTitle: string;
  selectionMarkdown: string | null;
  focusRangeId: string | null;
}
export interface DocumentEdit {
  old_text: string;
  new_text: string;
}

/**
 * TipTap writes `&nbsp;` into empty table cells. A space reads the same and keeps
 * files clean, but the output can't be cleaned as text: code blocks may contain
 * `| &nbsp; |` and a cell may literally say `&nbsp;`. So empty cells are marked
 * structurally before serializing and only the marker is replaced.
 */
const EMPTY_CELL_MARKER = "\uE000";
/** The most of a selection read_document quotes; the agent reads the rest by lines. */
const SELECTION_PREVIEW_CHARS = 2000;

function markEmptyCells(node: JSONContent): JSONContent {
  const [only, ...rest] = node.content ?? [];
  if (
    (node.type === "tableCell" || node.type === "tableHeader") &&
    only?.type === "paragraph" &&
    !only.content?.length &&
    !rest.length
  ) {
    return {
      ...node,
      content: [
        { type: "paragraph", content: [{ type: "text", text: EMPTY_CELL_MARKER }] },
      ],
    };
  }
  return node.content
    ? { ...node, content: node.content.map(markEmptyCells) }
    : node;
}

/**
 * StarterKit's trailing node keeps an empty paragraph after a final list, quote,
 * code block or table. It carries no content, so don't write it to disk as a
 * literal `&nbsp;`; the editor re-adds it on load.
 */
export function trimTrailingEmptyParagraph(markdown: string): string {
  return markdown.replace(/(?:\n+|^)&nbsp;\n*$/, "");
}

export function serializeDocument(editor: Editor): string {
  const manager = editor.storage.markdown?.manager;
  if (!manager) throw new Error("The markdown editor is not ready.");
  const { doc } = editor.state;
  // A note that already contains the marker character can't be told apart.
  if (doc.textContent.includes(EMPTY_CELL_MARKER))
    return manager.serialize(doc.toJSON());
  return manager
    .serialize(markEmptyCells(doc.toJSON()))
    .split(EMPTY_CELL_MARKER)
    .join(" ");
}
export function parseDocument(
  editor: Editor,
  markdown: string,
): ProseMirrorNode {
  const manager = editor.storage.markdown?.manager;
  if (!manager) throw new Error("The markdown editor is not ready.");
  const parsed = editor.schema.nodeFromJSON(manager.parse(markdown));
  const doc = parsed.content.size
    ? parsed
    : editor.schema.topNodeType.createAndFill();
  if (!doc)
    throw new Error("The markdown could not be represented in this editor.");
  doc.check();
  return doc;
}

/** Where one edit lands in the note's markdown as the earlier edits left it. */
interface LocatedEdit {
  start: number;
  end: number;
  text: string;
}

/** Validates edits and finds each in turn; every old_text must match exactly once. */
function locateEdits(markdown: string, edits: DocumentEdit[]): LocatedEdit[] {
  if (edits.length < 1 || edits.length > 20)
    throw new Error("Supply between 1 and 20 edits.");
  const located: LocatedEdit[] = [];
  for (const [index, edit] of edits.entries()) {
    const prefix = `Edit ${index + 1}`;
    if (
      typeof edit?.old_text !== "string" ||
      typeof edit?.new_text !== "string"
    ) {
      throw new Error(`${prefix}: old_text and new_text must be strings.`);
    }
    if (!edit.old_text)
      throw new Error(
        `${prefix}: old_text must not be empty; include the text to replace.`,
      );
    let count = 0;
    let position = markdown.indexOf(edit.old_text);
    const first = position;
    while (position !== -1) {
      count++;
      position = markdown.indexOf(edit.old_text, position + 1);
    }
    if (!count)
      throw new Error(
        `${prefix} not found: re-read the document, the user may have changed it.`,
      );
    if (count !== 1)
      throw new Error(
        `${prefix} matches ${count} places: include more surrounding text.`,
      );
    located.push({
      start: first,
      end: first + edit.old_text.length,
      text: edit.new_text,
    });
    markdown =
      markdown.slice(0, first) +
      edit.new_text +
      markdown.slice(first + edit.old_text.length);
  }
  return located;
}

/** A run of top-level blocks and where its markdown sits in the note's text. */
interface Segment {
  start: number;
  end: number;
  count: number;
}

/** Link reference definitions resolve note-wide, so a partial parse could miss one. */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

/**
 * Where each top-level block's markdown sits in `markdown` (the note as
 * read_document returned it), or null when that can't be established exactly.
 */
function indexBlocks(
  editor: Editor,
  doc: ProseMirrorNode,
  markdown: string,
): Segment[] | null {
  const manager = editor.storage.markdown?.manager;
  if (
    !manager ||
    !doc.childCount ||
    doc.textContent.includes(EMPTY_CELL_MARKER) ||
    REFERENCE_DEFINITION.test(markdown)
  )
    return null;
  const segments: Segment[] = [];
  let cursor = 0;
  for (let index = 0; index < doc.childCount; index++) {
    const text = manager
      .serialize({ type: "doc", content: [markEmptyCells(doc.child(index).toJSON())] })
      .split(EMPTY_CELL_MARKER)
      .join(" ")
      .trim();
    const start = text ? markdown.indexOf(text, cursor) : -1;
    if (start < 0 || markdown.slice(cursor, start).trim()) return null;
    segments.push({ start, end: start + text.length, count: 1 });
    cursor = start + text.length;
  }
  return markdown.slice(cursor).trim() ? null : segments;
}

/**
 * Applies one located edit by re-parsing only the blocks it touches plus one
 * neighbour on each side, which catches merges such as a paragraph becoming
 * part of an adjacent list. Untouched blocks keep their node identity, so the
 * tracked diff stays local too.
 */
function editBlocks(
  editor: Editor,
  doc: ProseMirrorNode,
  segments: Segment[],
  markdown: string,
  edit: LocatedEdit,
) {
  const delta = edit.text.length - (edit.end - edit.start);
  let low = segments.findIndex((segment) => segment.end > edit.start);
  if (low < 0) low = segments.length - 1;
  let high = low;
  while (high + 1 < segments.length && segments[high + 1].start < edit.end)
    high++;
  low = Math.max(0, low - 1);
  high = Math.min(segments.length - 1, high + 1);
  const from = Math.min(segments[low].start, edit.start);
  const to = Math.max(segments[high].end, edit.end) + delta;
  const next =
    markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);
  const source = next.slice(from, to);
  const nodes: ProseMirrorNode[] = [];
  if (source.trim())
    parseDocument(editor, source).forEach((node) => nodes.push(node));
  const count = (list: Segment[]) =>
    list.reduce((sum, segment) => sum + segment.count, 0);
  const children: ProseMirrorNode[] = [];
  doc.forEach((node) => children.push(node));
  children.splice(
    count(segments.slice(0, low)),
    count(segments.slice(low, high + 1)),
    ...nodes,
  );
  const target = children.length
    ? doc.type.create(doc.attrs, children)
    : doc.type.createAndFill();
  if (!target)
    throw new Error("The markdown could not be represented in this editor.");
  target.check();
  return {
    doc: target,
    markdown: next,
    segments: [
      ...segments.slice(0, low),
      ...(nodes.length ? [{ start: from, end: to, count: nodes.length }] : []),
      ...segments.slice(high + 1).map((segment) => ({
        ...segment,
        start: segment.start + delta,
        end: segment.end + delta,
      })),
    ],
  };
}

/**
 * The document after each edit in turn. Long notes are re-parsed only around
 * each edit; if the block index can't be built exactly, the whole note is
 * parsed per edit, which is always correct but slow on long notes.
 */
export function editedDocuments(
  editor: Editor,
  markdown: string,
  edits: DocumentEdit[],
): ProseMirrorNode[] {
  const located = locateEdits(markdown, edits);
  let doc = editor.state.doc;
  let segments = indexBlocks(editor, doc, markdown);
  const documents: ProseMirrorNode[] = [];
  for (const edit of located) {
    if (segments) {
      const next = editBlocks(editor, doc, segments, markdown, edit);
      ({ doc, segments, markdown } = next);
    } else {
      markdown =
        markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);
      doc = parseDocument(editor, markdown);
    }
    documents.push(doc);
  }
  return documents;
}

export function minimalDocumentDiff(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
): { from: number; to: number; slice: Slice } | null {
  const from = before.content.findDiffStart(after.content);
  if (from === null) return null;
  const end = before.content.findDiffEnd(after.content)!;
  // Repeated text can make the common suffix overlap the common prefix.
  const overlap = Math.max(0, from - end.a, from - end.b);
  return {
    from,
    to: end.a + overlap,
    slice: after.slice(from, end.b + overlap),
  };
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordCharAt(doc: ProseMirrorNode, from: number, to: number): boolean {
  // Probes step one past the changed range, which can leave the document
  // (a changed first block yields from = 0); resolve() throws outside it.
  if (from < 0 || to > doc.content.size || from >= to) return false;
  const $from = doc.resolve(from);
  if (!$from.parent.isTextblock) return false;
  const start = $from.start();
  const end = start + $from.parent.content.size;
  if (from < start || to > end) return false;
  return WORD_CHAR.test(doc.textBetween(from, to, "\n", "\ufffc"));
}

/**
 * Widen a replacement so a review shows whole words ("Friday" → "Saturday")
 * instead of the character-minimal diff ("Fri" → "Satur" + shared "day").
 * Pure insertions and deletions stay minimal. The widened parts are identical
 * in both documents, so rejecting the hunk still restores the exact old text.
 */
function alignToWords(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  diff: { from: number; to: number; slice: Slice },
): { from: number; oldTo: number; newTo: number } {
  let from = diff.from;
  let oldTo = diff.to;
  let newTo = diff.from + diff.slice.size;
  if (oldTo === from || newTo === from) return { from, oldTo, newTo };
  while (
    isWordCharAt(before, from - 1, from) &&
    isWordCharAt(before, from, from + 1)
  )
    from--;
  while (
    isWordCharAt(before, oldTo - 1, oldTo) &&
    isWordCharAt(before, oldTo, oldTo + 1) &&
    isWordCharAt(after, newTo, newTo + 1)
  ) {
    oldTo++;
    newTo++;
  }
  return { from, oldTo, newTo };
}

/**
 * Replace `tr.doc` with `target` through its minimal changed range and return
 * the hunk that tracks it. Nothing is dispatched, so callers can batch steps.
 */
function trackedStep(
  tr: Transaction,
  target: ProseMirrorNode,
  origin: AgentChange["origin"],
  runId: string | null,
): AgentChange | null {
  const before = tr.doc;
  const diff = minimalDocumentDiff(before, target);
  if (!diff) return null;
  tr.replace(diff.from, diff.to, diff.slice);
  const range = alignToWords(before, tr.doc, diff);
  return {
    id: crypto.randomUUID(),
    origin,
    runId,
    from: range.from,
    to: range.newTo,
    oldSlice: before.slice(range.from, range.oldTo),
  };
}

/**
 * Apply every target document in order as one transaction with one hunk per
 * step. Building the whole transaction before dispatching keeps a batch atomic:
 * if any step throws, the editor is untouched.
 */
export function applyTrackedDocuments(
  editor: Editor,
  targets: ProseMirrorNode[],
  origin: AgentChange["origin"],
  runId: string | null,
): number {
  const tr = closeHistory(editor.state.tr);
  const added: AgentChange[] = [];
  for (const target of targets) {
    const firstStep = tr.steps.length;
    const change = trackedStep(tr, target, origin, runId);
    if (!change) continue;
    const later = tr.mapping.slice(firstStep);
    for (const hunk of added) {
      hunk.from = later.map(hunk.from, -1);
      hunk.to = later.map(hunk.to, 1);
    }
    added.push(change);
  }
  if (!added.length) return 0;
  setChangeMeta(tr, {
    source: origin === "agent" ? "agent" : "merge",
    add: added,
  });
  editor.view.dispatch(tr);
  return added.length;
}

export function applyTrackedReplacement(
  editor: Editor,
  from: number,
  to: number,
  slice: Slice,
  origin: AgentChange["origin"],
  runId: string | null,
  fit = false,
): void {
  const tr = editor.state.tr;
  if (fit) tr.replaceRange(from, to, slice);
  else tr.replace(from, to, slice);
  // A fitted block replacement may expand the actual changed range, so track
  // the real difference rather than the requested one.
  applyTrackedDocuments(editor, [tr.doc], origin, runId);
}

/**
 * Captures what a run works on: the note, and the selection attached to the
 * panel (which may have been made before the user clicked elsewhere). The
 * selection becomes the run's focus range and is detached from the panel.
 */
export function captureRunBinding(
  editor: Editor,
  runId: string,
): RunBinding | null {
  const document = editor.storage.scratchDocument;
  if (!document?.noteId) return null;
  const range = attachedRange(editor);
  let selectionMarkdown: string | null = null;
  let focusRangeId: string | null = null;
  if (range) {
    const manager = editor.storage.markdown?.manager;
    if (!manager) return null;
    selectionMarkdown = manager.serialize({
      type: "doc",
      content: editor.state.doc.slice(range.from, range.to).content.toJSON(),
    });
    focusRangeId = crypto.randomUUID();
    detachSelection(editor);
    editor.view.dispatch(
      setChangeMeta(editor.state.tr, {
        focus: { id: focusRangeId, from: range.from, to: range.to },
      }).setMeta("addToHistory", false),
    );
  }
  return {
    runId,
    documentSession: document.session,
    noteId: document.noteId,
    noteTitle: document.title,
    selectionMarkdown,
    focusRangeId,
  };
}

export function releaseRunBinding(
  editor: Editor | null,
  binding: RunBinding,
): void {
  if (!editor || editor.isDestroyed || !binding.focusRangeId) return;
  editor.view.dispatch(
    setChangeMeta(editor.state.tr, {
      releaseFocus: binding.focusRangeId,
    }).setMeta("addToHistory", false),
  );
}

function objectArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Tool arguments must be an object.");
  return args as Record<string, unknown>;
}

export async function executeDocumentTool(
  editor: Editor | null,
  binding: RunBinding,
  name: string,
  args: unknown,
): Promise<{ ok: boolean; output: string }> {
  try {
    if (
      !editor ||
      editor.isDestroyed ||
      !editor.storage.scratchDocument.noteId ||
      binding.documentSession !== editor.storage.scratchDocument.session
    ) {
      throw new Error(
        `${binding.noteTitle} is no longer open, so the edit was not applied.`,
      );
    }
    const input = objectArgs(args);
    if (name === "read_document") {
      const range = agentChangesKey
        .getState(editor.state)
        ?.focusRanges.find((item) => item.id === binding.focusRangeId);
      let selection = "none";
      if (range && range.from < range.to) {
        const markdown = editor.storage.markdown.manager.serialize({
          type: "doc",
          content: editor.state.doc
            .slice(range.from, range.to)
            .content.toJSON(),
        });
        selection =
          markdown.length > SELECTION_PREVIEW_CHARS
            ? `(first ${SELECTION_PREVIEW_CHARS} of ${markdown.length} characters) ${JSON.stringify(markdown.slice(0, SELECTION_PREVIEW_CHARS))}`
            : JSON.stringify(markdown);
      }
      return {
        ok: true,
        output: `Note: ${editor.storage.scratchDocument.title}\nSelection: ${selection}\n---\n${serializeDocument(editor)}`,
      };
    }
    if (name === "edit_document") {
      if (!Array.isArray(input.edits))
        throw new Error("edits must be an array of replacements.");
      const documents = editedDocuments(
        editor,
        serializeDocument(editor),
        input.edits as DocumentEdit[],
      );
      applyTrackedDocuments(editor, documents, "agent", binding.runId);
      return { ok: true, output: `Applied ${documents.length} edit(s).` };
    }
    if (name === "replace_selection") {
      if (typeof input.new_text !== "string")
        throw new Error("new_text must be a string.");
      const range = agentChangesKey
        .getState(editor.state)
        ?.focusRanges.find((item) => item.id === binding.focusRangeId);
      if (!range || range.from >= range.to)
        throw new Error(
          "This run has no remaining selection. Select text and send a new message.",
        );
      const parsed = parseDocument(editor, input.new_text);
      const { doc } = editor.state;
      const $from = doc.resolve(range.from);
      const $to = doc.resolve(range.to);
      const inline =
        $from.sameParent($to) &&
        $from.parent.isTextblock &&
        parsed.childCount === 1 &&
        parsed.firstChild?.type.name === "paragraph";
      const content = inline ? parsed.firstChild!.content : parsed.content;
      const slice = new Slice(input.new_text ? content : Fragment.empty, 0, 0);
      applyTrackedReplacement(
        editor,
        range.from,
        range.to,
        slice,
        "agent",
        binding.runId,
        !inline,
      );
      return { ok: true, output: "Replaced selection." };
    }
    throw new Error(`Unknown document tool: ${name}`);
  } catch (error) {
    return {
      ok: false,
      output:
        error instanceof Error
          ? error.message
          : "The document edit could not be applied.",
    };
  }
}
