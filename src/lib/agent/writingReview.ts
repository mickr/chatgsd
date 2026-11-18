import type { Editor } from "@tiptap/core";

/** Keep UTF-16 truncation from sending half an emoji across the native JSON bridge. */
export function boundedReviewText(text: string, limit: number): string {
  return text.slice(0, limit).replace(/[\uD800-\uDFFF]/gu, "");
}

// Models dress a label up: accept a heading, emphasis or different case around it.
const STARTERS_MARK = /^[ \t#*_]*starters:?[ \t*_]*$/im;
const MAX_STARTERS = 4;
const MAX_STARTER_CHARS = 80;

/**
 * Split a check-in reply into its observation and the next moves the agent
 * proposes for this note. Anything that isn't a short plain line is dropped.
 */
export function splitStarters(reply: string): { advice: string; starters: string[] } {
  const mark = STARTERS_MARK.exec(reply);
  if (!mark) return { advice: reply, starters: [] };
  const starters = reply.slice(mark.index + mark[0].length).split("\n")
    .map((line) => line.replace(/^[\s\-*•\d.)]+/, "").replace(/^["“]|["”]$/g, "").trim())
    .filter((line) => line && line.length <= MAX_STARTER_CHARS);
  return { advice: reply.slice(0, mark.index), starters: [...new Set(starters)].slice(0, MAX_STARTERS) };
}

const MAX_PARAGRAPHS = 24;
const MAX_PASSAGE = 5900;

/**
 * Label bounded paragraphs so a classifier can point at real text: those near
 * the cursor, or with `whole` an overview of the note. A note that fits is sent
 * as it is either way, so the two views of a short note are the same passage.
 */
export function writingPassage(editor: Editor, whole = false) {
  const { doc, selection } = editor.state;
  const ranges: Array<{ from: number; to: number }> = [];
  let passage = "";
  if (whole) {
    const blocks: Array<{ from: number; to: number; text: string }> = [];
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return;
      const text = node.textContent.trim();
      if (text) blocks.push({ from: pos, to: pos + node.nodeSize, text });
      return false;
    });
    const fits = blocks.length <= MAX_PARAGRAPHS &&
      blocks.reduce((size, block, index) => size + block.text.length + `\n\n[p${index}] `.length, 0) <= MAX_PASSAGE;
    if (!fits) {
      // Spread the labels across the note and open each paragraph, so the
      // classifier can point at a weak section it would never reach by cursor.
      const step = Math.max(1, blocks.length / MAX_PARAGRAPHS);
      const chosen = Array.from({ length: Math.min(MAX_PARAGRAPHS, blocks.length) }, (_, index) => blocks[Math.floor(index * step)]);
      const excerpt = Math.floor(MAX_PASSAGE / chosen.length) - 8;
      for (const block of chosen) {
        passage += `${passage ? "\n\n" : ""}[p${ranges.length}] ${boundedReviewText(block.text, excerpt)}`;
        ranges.push({ from: block.from, to: block.to });
      }
      return { passage, ranges };
    }
  }
  const start = Math.max(0, selection.to - 3000);
  const end = Math.min(doc.content.size, selection.to + 3000);
  doc.nodesBetween(start, end, (node, pos) => {
    if (!node.isTextblock) return;
    if (ranges.length >= 24 || passage.length >= 5900) return false;
    const offset = Math.max(0, start - pos - 1);
    const text = node.textBetween(offset, Math.min(node.content.size, offset + 6000), " ").trim();
    if (!text) return false;
    const prefix = `${passage ? "\n\n" : ""}[p${ranges.length}] `;
    const excerpt = boundedReviewText(text, 6000 - passage.length - prefix.length);
    if (!excerpt) return false;
    passage += prefix + excerpt;
    ranges.push({ from: pos, to: pos + node.nodeSize });
    return false;
  });
  return { passage, ranges };
}
