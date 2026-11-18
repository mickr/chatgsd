import type { Transaction } from "@tiptap/pm/state";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { agentChangesKey } from "../../components/editor/AgentChanges";

/** Recognize the actual reversal of an agent edit, rather than inferring intent
 * from arbitrary typing. Redo retracts the same observation. */
export function trackWriterCorrection() {
  let last: { before: Transaction["doc"]; after: Transaction["doc"]; kept: string; proposed: string } | null = null;
  return (tr: Transaction) => {
    if (!tr.docChanged) return null;
    if (last && isHistoryTransaction(tr)) {
      if (tr.before.eq(last.after) && tr.doc.eq(last.before))
        return { kept: last.kept, proposed: last.proposed, restored: true };
      if (tr.before.eq(last.before) && tr.doc.eq(last.after))
        return { kept: last.kept, proposed: last.proposed, restored: false };
    }
    last = null;
    if (tr.getMeta(agentChangesKey)?.source !== "agent") return null;
    const start = tr.before.content.findDiffStart(tr.doc.content);
    const end = tr.before.content.findDiffEnd(tr.doc.content);
    if (start == null || !end) return null;
    const before = tr.before.resolve(start), after = tr.doc.resolve(start);
    if (!before.parent.isTextblock || !after.parent.isTextblock ||
        end.a > before.end() || end.b > after.end()) return null;
    const kept = before.parent.textContent, proposed = after.parent.textContent;
    if (kept.trim() && proposed.trim() && kept !== proposed && kept.length <= 500 && proposed.length <= 500)
      last = { before: tr.before, after: tr.doc, kept, proposed };
    return null;
  };
}
