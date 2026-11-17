import { useEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { agentChangesKey } from "./AgentChanges";

/** Follow the agent's rendered caret, never the user's editor selection. */
export function AgentFollow({ editor, containerRef }: {
  editor: Editor;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const [available, setAvailable] = useState(false);
  const [following, setFollowing] = useState(false);
  const followingRef = useRef(false);
  const revealRef = useRef<() => void>(() => {});

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    let previous = agentChangesKey.getState(editor.state);
    const pause = () => {
      followingRef.current = false;
      setFollowing(false);
      cancelAnimationFrame(frame);
    };
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!followingRef.current) return;
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
    revealRef.current = reveal;
    const update = () => {
      const changes = agentChangesKey.getState(editor.state);
      const presence = changes?.presence.agent;
      setAvailable(Boolean(presence));
      if (!presence) pause();
      else if ((presence !== previous?.presence.agent || changes?.arrival !== previous?.arrival) && followingRef.current) reveal();
      previous = changes;
    };
    update();
    editor.on("transaction", update);
    // User intent pauses following; programmatic scrolling does not.
    const events = ["wheel", "touchstart", "pointerdown", "keydown", "beforeinput"] as const;
    for (const event of events) container.addEventListener(event, pause, { passive: true });
    return () => {
      editor.off("transaction", update);
      for (const event of events) container.removeEventListener(event, pause);
      cancelAnimationFrame(frame);
      followingRef.current = false;
      revealRef.current = () => {};
    };
  }, [editor, containerRef]);

  if (!available) return null;
  return (
    <button
      type="button"
      className="agent-follow"
      aria-pressed={following}
      title={following ? "Stop following. Scrolling or typing also pauses following." : "Keep the agent's work in view without moving your cursor"}
      onClick={() => {
        const next = !followingRef.current;
        followingRef.current = next;
        setFollowing(next);
        if (next) revealRef.current();
      }}
    >
      <span className="agent-follow-dot" aria-hidden="true" />
      {following ? "Following agent" : "Follow agent"}
    </button>
  );
}
