import type { Editor } from "@tiptap/core";

/** Keep UTF-16 truncation from sending half an emoji across the native JSON bridge. */
export function boundedReviewText(text: string, limit: number): string {
  return text.slice(0, limit).replace(/[\uD800-\uDFFF]/gu, "");
}

/** Label bounded, nearby paragraphs so a classifier can point at real text. */
export function writingPassage(editor: Editor) {
  const { doc, selection } = editor.state;
  const ranges: Array<{ from: number; to: number }> = [];
  let passage = "";
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
