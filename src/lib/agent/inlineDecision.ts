import { classifyInlineContext, type InlineDecision, type InlineIntent } from "../../services/agent";
import type { Editor } from "@tiptap/core";
import type { TranscriptItem } from "../../context/AgentContext";
import { displayInstruction } from "../../components/agent/InlineAgentActivity";


export const intentGuidance: Record<InlineIntent, string> = {
  discuss: "Answer in the conversation without editing notes. If the request seems to require an edit, clarify first.",
  suggest: "Offer suggestions or proposed wording in the conversation. Do not apply changes to notes.",
  edit: "Make only the changes the user explicitly requested. Classification itself is not permission to edit.",
  research: "Research the question and report findings with sources in the conversation. Do not edit notes.",
  clarify: "Ask one short question to resolve the ambiguity before taking action. Do not edit notes.",
};

export const intentSuggestions: Record<InlineIntent, readonly string[]> = {
  discuss: ["Explain this passage", "Summarize the main idea", "What am I missing?"],
  suggest: ["Suggest improvements", "Offer another approach", "Challenge this argument"],
  edit: ["Make this clearer", "Tighten this passage", "Suggest wording first"],
  research: ["Check the facts", "Find supporting sources", "What needs verifying?"],
  clarify: ["Help me think this through", "What should I clarify?", "Suggest next steps"],
};

export function classifyInline(
  editor: Editor,
  range: { from: number; to: number },
  message: string,
  items: TranscriptItem[],
): Promise<InlineDecision> {
  if (message.trim().length > 8000)
    return Promise.reject(new Error("Keep inline messages under 8,000 characters so the classifier can read the entire request."));
  const { doc } = editor.state;
  const history: Array<{ role: string; text: string }> = [];
  for (let index = items.length - 1; index >= 0 && history.length < 6; index--) {
    const item = items[index];
    if (item.type === "user") history.push({ role: "user", text: displayInstruction(item.text).slice(0, 2000) });
    else if (item.type === "text") history.push({ role: "assistant", text: item.text.slice(0, 2000) });
  }
  history.reverse();
  return classifyInlineContext({
      title: editor.storage.scratchDocument.title.slice(0, 500),
      selection: doc.textBetween(range.from, Math.min(range.to, range.from + 4000), "\n\n"),
      before: doc.textBetween(Math.max(0, range.from - 2000), range.from, "\n\n"),
      after: doc.textBetween(range.to, Math.min(doc.content.size, range.to + 2000), "\n\n"),
      message: message.trim(),
      history,
  });
}
