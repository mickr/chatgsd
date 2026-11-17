import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { agentChangesKey } from "../../components/editor/AgentChanges";

/** Observe local editing, not agent transactions, sync, selection moves or loads. */
export function useCoeditingObserver(
  editor: Editor | null,
  enabled: boolean,
  busy: boolean,
  onCheckIn: () => void,
  idleMs = 2000,
  minCheckInMs = 10000,
): void {
  const latest = useRef({ enabled, busy, onCheckIn });
  latest.current = { enabled, busy, onCheckIn };
  const reschedule = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;
    let editedAt = 0;
    let checkedAt = -Infinity;
    let session = editor.storage.scratchDocument.session;
    const clear = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clear();
      if (!latest.current.enabled || editor.isDestroyed) {
        dirty = false;
        return;
      }
      if (!dirty || latest.current.busy) return;
      const delay = Math.max(0, editedAt + idleMs - Date.now(), checkedAt + minCheckInMs - Date.now());
      timer = setTimeout(() => {
        if (!latest.current.enabled || editor.isDestroyed || session !== editor.storage.scratchDocument.session) {
          dirty = false;
          return;
        }
        if (latest.current.busy) return;
        if (editor.view.composing) {
          editedAt = Date.now();
          schedule();
          return;
        }
        dirty = false;
        checkedAt = Date.now();
        latest.current.onCheckIn();
      }, delay);
    };
    const changed = ({ transaction }: { transaction: Transaction }) => {
      const meta = transaction.getMeta(agentChangesKey);
      if (session !== editor.storage.scratchDocument.session || meta?.clear) {
        session = editor.storage.scratchDocument.session;
        dirty = false;
        clear();
        return;
      }
      const original = transaction.getMeta("appendedTransaction") as Transaction | undefined;
      if (!transaction.docChanged || meta?.source || original?.getMeta(agentChangesKey)?.source ||
          transaction.getMeta("addToHistory") === false || transaction.getMeta("preventUpdate") !== undefined) return;
      if (!latest.current.enabled) return;
      dirty = true;
      editedAt = Date.now();
      schedule();
    };
    reschedule.current = schedule;
    editor.on("transaction", changed);
    return () => {
      clear();
      reschedule.current = null;
      editor.off("transaction", changed);
    };
  }, [editor, idleMs, minCheckInMs]);

  useEffect(() => { reschedule.current?.(); }, [enabled, busy]);
}
