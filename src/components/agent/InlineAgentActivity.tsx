import type { Conversation, TranscriptItem } from "../../context/AgentContext";
import { splitReply } from "../../lib/agent/ui/content";

export type InlineActivityState = "thinking" | "reading" | "editing" | "researching" | "responding" | "waiting" | "done" | "paused" | "error";

export function displayInstruction(text: string): string {
  // Older saved conversations used the edit-only preamble.
  if (!text.startsWith("Inline agent request.") &&
      !text.startsWith("Inline edit request. Apply the instruction directly in the current note.")) return text;
  const separator = "\n\nUser instruction:\n\n";
  const start = text.indexOf(separator);
  return start < 0 ? text : text.slice(start + separator.length);
}

export function inlineTurnPreview(items: TranscriptItem[]): { turn: number; text: string } {
  let turn = 0;
  let text = "";
  let reply = "";
  for (const item of items) {
    if (!turn || item.type === "user" || item.type === "activity") {
      turn++;
      text = "";
      reply = "";
    }
    if (item.type === "user") text = displayInstruction(item.text);
    else if (item.type === "text") reply = item.text;
    else if (item.type === "activity") text = item.text;
    else if (item.type === "question") {
      text = item.question;
      reply = "";
    }
  }
  const prose = splitReply(reply, true)
    .filter((segment) => segment.type === "text")
    .map((segment) => segment.text)
    .join("\n");
  if (prose.trim()) text = prose;
  return { turn, text: text.replace(/\s+/g, " ").trim() };
}

export function inlineActivity(conversation: Conversation, waiting: boolean, starting: boolean, failed: boolean): { state: InlineActivityState; label: string } {
  if (failed || conversation.error) return { state: "error", label: "Something went wrong" };
  if (waiting) return { state: "waiting", label: "A question for you" };
  if (starting) return { state: "thinking", label: "Getting started" };
  if (!conversation.runId) return conversation.cancelled
    ? { state: "paused", label: "Paused" }
    : { state: "done", label: "Done" };

  // Only describe the current turn. A saved, unfinished tool from an older
  // turn must never make the face claim that work is still happening.
  for (let index = conversation.items.length - 1; index >= 0; index--) {
    const item = conversation.items[index];
    if (item.type === "user" || item.type === "activity") break;
    if (item.type === "tool" && item.ok === undefined && item.output === undefined) {
      if (["edit_document", "replace_selection", "edit_note"].includes(item.name))
        return { state: "editing", label: "Editing your note" };
      if (["research", "web_search", "web_fetch"].includes(item.name))
        return { state: "researching", label: "Researching" };
      if (["read_document", "read_notes", "search_notes", "list_notes", "find_in_note", "note_links", "read_skill"].includes(item.name))
        return { state: "reading", label: "Reading" };
      return { state: "thinking", label: "Working" };
    }
  }
  return conversation.items[conversation.items.length - 1]?.type === "text"
    ? { state: "responding", label: "Writing a reply" }
    : { state: "thinking", label: "Thinking" };
}

