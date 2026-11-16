import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/** What the panel shows about a selection. */
export interface SelectionSummary {
  /** The opening of the selection as markdown, enough for a preview. */
  markdown: string;
  /** The preview leaves part of the selection out. */
  clipped: boolean;
  words: number;
  /** The heading the selection sits under, if it starts below one. */
  section: string | null;
  /** Where it is in the note now, to scroll to; null once it's gone. */
  range: { from: number; to: number } | null;
}

const PREVIEW_BLOCKS = 6;
const PREVIEW_CHARS = 600;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

export function countWords(text: string): number {
  let count = 0;
  for (const _ of text.matchAll(WORD)) count++;
  return count;
}

/** Cuts a preview at a word boundary. */
export function clipPreview(markdown: string, limit = PREVIEW_CHARS) {
  const text = markdown.trim();
  if (text.length <= limit) return { markdown: text, clipped: false };
  const cut = text.lastIndexOf(" ", limit);
  return {
    markdown: `${text.slice(0, cut > limit * 0.6 ? cut : limit).trimEnd()}…`,
    clipped: true,
  };
}

/**
 * The heading a position sits under. A selection that starts with a heading is
 * its own section, so it's placed under that heading's parent instead.
 */
export function sectionAt(doc: ProseMirrorNode, pos: number): string | null {
  const open: Array<{ level: number; text: string }> = [];
  const close = (level: number) => {
    while (open.length && open[open.length - 1].level >= level) open.pop();
  };
  let offset = 0;
  for (let index = 0; index < doc.childCount; index++) {
    const node = doc.child(index);
    const level = node.type.name === "heading" ? Number(node.attrs.level) : 0;
    if (offset + node.nodeSize > pos) {
      if (level) close(level);
      break;
    }
    if (level) {
      close(level);
      open.push({ level, text: node.textContent.trim() });
    }
    offset += node.nodeSize;
  }
  return open.length ? open[open.length - 1].text || null : null;
}

/**
 * Summarizes the editor's text from `from` to `to`. Only the opening blocks
 * are serialized, so this stays cheap while dragging across a long note.
 */
export function summarizeRange(
  editor: Editor,
  from: number,
  to: number,
): SelectionSummary | null {
  const manager = editor.storage.markdown?.manager;
  if (!manager || from >= to) return null;
  const { doc } = editor.state;
  const content = doc.slice(from, to).content;
  const opening: ReturnType<ProseMirrorNode["toJSON"]>[] = [];
  for (let index = 0; index < Math.min(content.childCount, PREVIEW_BLOCKS); index++)
    opening.push(content.child(index).toJSON());
  const preview = clipPreview(manager.serialize({ type: "doc", content: opening }));
  return {
    ...preview,
    clipped: preview.clipped || content.childCount > PREVIEW_BLOCKS,
    words: countWords(doc.textBetween(from, to, " ")),
    section: sectionAt(doc, from),
    range: { from, to },
  };
}

/** Summarizes a selection captured as markdown when a message was sent. */
export function summarizeMarkdown(
  markdown: string,
  editor: Editor | null,
  range: { from: number; to: number } | null,
): SelectionSummary {
  return {
    ...clipPreview(markdown),
    words: countWords(markdown),
    section: editor && range ? sectionAt(editor.state.doc, range.from) : null,
    range,
  };
}
