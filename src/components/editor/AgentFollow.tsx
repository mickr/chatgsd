import { useEffect, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { agentChangesKey } from "./AgentChanges";

const preferenceKey = "chatgsd.followAgent";

/** Follow the agent's rendered caret, never the user's editor selection. */
export function AgentFollow({ editor, containerRef }: {
  editor: Editor;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const [available, setAvailable] = useState(false);
  const [following, setFollowing] = useState(() => {
    try { return localStorage.getItem(preferenceKey) === "true"; }
    catch { return false; }
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const caret = editor.view.dom.querySelector(".agent-presence-caret");
        if (!caret) return;
        const target = caret.getBoundingClientRect();
        const viewport = container.getBoundingClientRect();
        // Leave room for the label and surrounding prose. Scroll only this pane.
        const margin = Math.min(80, viewport.height / 4);
        if (target.top >= viewport.top + margin && target.bottom <= viewport.bottom - margin) return;
        container.scrollTo({
          top: container.scrollTop + target.top - viewport.top - viewport.height / 2,
          behavior: "instant",
        });
      });
    };
    const update = ({ transaction }: { transaction?: Transaction } = {}) => {
      const presence = agentChangesKey.getState(editor.state)?.presence.agent;
      setAvailable(Boolean(presence));
      if (!presence) cancelAnimationFrame(frame);
      else if (following) {
        // Typing can map the agent's position without the agent doing any work.
        const meta = transaction?.getMeta(agentChangesKey);
        if (!transaction || meta?.presence?.agent || meta?.reveal !== undefined || meta?.clearArrival) reveal();
      }
    };
    update();
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
      cancelAnimationFrame(frame);
    };
  }, [editor, containerRef, following]);

  if (!available && !following) return null;
  return (
    <button
      type="button"
      className="agent-follow"
      aria-pressed={following}
      title={following ? "Stop following the agent" : "Keep the agent's work in view without moving your cursor"}
      onClick={() => {
        const next = !following;
        setFollowing(next);
        try { localStorage.setItem(preferenceKey, String(next)); }
        catch { /* The toggle still works when storage is unavailable. */ }
      }}
    >
      <span className="agent-follow-dot" aria-hidden="true" />
      {following ? "Following agent" : "Follow agent"}
    </button>
  );
}
