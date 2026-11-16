import { diffIndices } from "node-diff3";

export interface NoteChange {
  noteTitle: string;
  hunks: Array<{ before: string[]; after: string[]; line?: number }>;
}

/** Compare only the synchronous agent operation, never the whole user/agent turn. */
export function documentChange(noteTitle: string, before: string, after: string): NoteChange {
  return {
    noteTitle,
    hunks: diffIndices(before.split("\n"), after.split("\n")).map((diff) => ({
      before: diff.buffer1Content,
      after: diff.buffer2Content,
      line: diff.buffer1[0] + 1,
    })),
  };
}

/** Disk edits are exact replacements; only call this after a successful write. */
export function noteEditChange(input: unknown): NoteChange | null {
  if (!input || typeof input !== "object") return null;
  const { id, edits } = input as Record<string, unknown>;
  if (typeof id !== "string" || !Array.isArray(edits)) return null;
  const hunks: NoteChange["hunks"] = [];
  for (const edit of edits) {
    if (!edit || typeof edit.old_text !== "string" || typeof edit.new_text !== "string") return null;
    if (edit.old_text !== edit.new_text) hunks.push({
      before: edit.old_text ? edit.old_text.split("\n") : [],
      after: edit.new_text ? edit.new_text.split("\n") : [],
    });
  }
  return hunks.length ? { noteTitle: id, hunks } : null;
}
