import type { Editor } from "@tiptap/core";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import { diffIndices } from "node-diff3";
import { setChangeMeta } from "../../components/editor/AgentChanges";
import {
  applyTrackedReplacement,
  minimalDocumentDiff,
  parseDocument,
} from "./documentTools";

export interface ExternalChange {
  noteId: string;
  content: string;
  modified: number;
  seq: number;
}
export interface MergeChunk {
  from: number;
  to: number;
  nodes: ProseMirrorNode[];
  conflict: boolean;
}
interface BlockEdit {
  from: number;
  to: number;
  keys: string[];
  side: "ours" | "theirs";
}

function blocks(doc: ProseMirrorNode): string[] {
  const result: string[] = [];
  doc.forEach((node) => result.push(JSON.stringify(node.toJSON())));
  return result;
}
function overlaps(a: BlockEdit, b: BlockEdit): boolean {
  if (a.from === a.to && b.from === b.to) return a.from === b.from;
  if (a.from === a.to) return a.from > b.from && a.from < b.to;
  if (b.from === b.to) return b.from > a.from && b.from < a.to;
  return a.from < b.to && b.from < a.to;
}
function applyRegion(
  base: string[],
  from: number,
  to: number,
  edits: BlockEdit[],
): string[] {
  const result: string[] = [];
  let cursor = from;
  for (const edit of edits) {
    result.push(...base.slice(cursor, edit.from), ...edit.keys);
    cursor = edit.to;
  }
  result.push(...base.slice(cursor, to));
  return result;
}
function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/** Block coordinates always refer to the original live (ours) document. */
export function mergeDocuments(
  base: ProseMirrorNode,
  ours: ProseMirrorNode,
  theirs: ProseMirrorNode,
): MergeChunk[] {
  const baseKeys = blocks(base);
  const oursKeys = blocks(ours);
  const theirsKeys = blocks(theirs);
  if (sameKeys(oursKeys, theirsKeys) || sameKeys(baseKeys, theirsKeys))
    return [];
  const changes: BlockEdit[] = [];
  for (const [side, keys] of [
    ["ours", oursKeys],
    ["theirs", theirsKeys],
  ] as const) {
    for (const diff of diffIndices(baseKeys, keys)) {
      changes.push({
        side,
        from: diff.buffer1[0],
        to: diff.buffer1[0] + diff.buffer1[1],
        keys: diff.buffer2Content,
      });
    }
  }
  changes.sort((a, b) => a.from - b.from || a.to - b.to);
  const groups: BlockEdit[][] = [];
  for (const change of changes) {
    const group = groups[groups.length - 1];
    if (group?.some((item) => overlaps(item, change))) group.push(change);
    else groups.push([change]);
  }
  const chunks: MergeChunk[] = [];
  let baseCursor = 0;
  let oursCursor = 0;
  for (const group of groups) {
    const from = Math.min(...group.map((edit) => edit.from));
    const to = Math.max(...group.map((edit) => edit.to));
    oursCursor += from - baseCursor;
    const oursEdits = group.filter((edit) => edit.side === "ours");
    const theirsEdits = group.filter((edit) => edit.side === "theirs");
    const localOurs = applyRegion(baseKeys, from, to, oursEdits);
    const localTheirs = applyRegion(baseKeys, from, to, theirsEdits);
    if (theirsEdits.length && !sameKeys(localOurs, localTheirs)) {
      chunks.push({
        from: oursCursor,
        to: oursCursor + localOurs.length,
        nodes: localTheirs.map((key) =>
          ours.type.schema.nodeFromJSON(JSON.parse(key)),
        ),
        conflict: oursEdits.length > 0,
      });
    }
    oursCursor += localOurs.length;
    baseCursor = to;
  }
  return chunks;
}

function blockPosition(doc: ProseMirrorNode, index: number): number {
  let position = 0;
  for (let i = 0; i < index; i++) position += doc.child(i).nodeSize;
  return position;
}

export function mergeExternalContent(
  editor: Editor,
  baseMarkdown: string,
  theirsMarkdown: string,
): boolean {
  const chunks = mergeDocuments(
    parseDocument(editor, baseMarkdown),
    editor.state.doc,
    parseDocument(editor, theirsMarkdown),
  );
  for (const chunk of chunks.slice().reverse()) {
    const doc = editor.state.doc;
    const from = blockPosition(doc, chunk.from);
    const to = blockPosition(doc, chunk.to);
    let replacement = Fragment.fromArray(chunk.nodes);
    // A document must retain one textblock after deleting its last block.
    if (from === 0 && to === doc.content.size && !replacement.size)
      replacement = Fragment.from(editor.schema.nodes.paragraph.create());
    const next = doc.replace(from, to, new Slice(replacement, 0, 0));
    const diff = minimalDocumentDiff(doc, next);
    if (!diff) continue;
    if (chunk.conflict)
      applyTrackedReplacement(
        editor,
        diff.from,
        diff.to,
        diff.slice,
        "external",
        null,
      );
    else
      editor.view.dispatch(
        setChangeMeta(editor.state.tr.replace(diff.from, diff.to, diff.slice), {
          source: "merge",
        }),
      );
  }
  return chunks.length > 0;
}

export async function markdownHash(markdown: string): Promise<string> {
  const bytes = new TextEncoder().encode(markdown);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
