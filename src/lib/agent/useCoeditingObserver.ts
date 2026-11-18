import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { agentChangesKey } from "../../components/editor/AgentChanges";

/**
 * Observe local editing, not agent transactions, sync or loads. With
 * `watchSelection`, the user moving to another place counts as activity too.
 */
export function useCoeditingObserver(
  editor: Editor | null,
  enabled: boolean,
  busy: boolean,
  onCheckIn: () => void,
  idleMs = 2000,
  minCheckInMs = 10000,
  watchSelection = false,
): void {
  const latest = useRef({ enabled, busy, onCheckIn, watchSelection });
  latest.current = { enabled, busy, onCheckIn, watchSelection };
  const reschedule = useRef<(() => void) | null>(null);
  // Outlives a change of cadence, so slowing down never grants an early check-in.
  const checkedAt = useRef(-Infinity);

  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;
    let editedAt = 0;
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
      const delay = Math.max(0, editedAt + idleMs - Date.now(), checkedAt.current + minCheckInMs - Date.now());
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
        checkedAt.current = Date.now();
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
      const moved = !transaction.docChanged && transaction.selectionSet && latest.current.watchSelection;
      if (!(transaction.docChanged || moved) || meta?.source || original?.getMeta(agentChangesKey)?.source ||
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
