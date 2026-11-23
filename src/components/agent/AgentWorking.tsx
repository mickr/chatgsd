import { memo, useEffect, useRef, useState } from "react";
import type { AgentExpression } from "../../services/agent";
import type { InlineActivityState } from "./InlineAgentActivity";
import { InlineAgentFace } from "./InlineAgentFace";
import "./AgentWorking.css";

/** Seconds of work before the indicator starts counting, so quick answers stay quiet. */
const SHOW_ELAPSED_AFTER = 4;

/**
 * Show something at once, keep it at least `min` ms, then let it leave over
 * `exit` ms. Returns null once it has gone.
 */
export function useLingering(show: boolean, min: number, exit: number) {
  const [phase, setPhase] = useState<"shown" | "leaving" | null>(show ? "shown" : null);
  const shownAt = useRef(show ? Date.now() : 0);
  useEffect(() => {
    if (show) {
      if (phase !== "shown") {
        shownAt.current = Date.now();
        setPhase("shown");
      }
      return;
    }
    if (!phase) return;
    const timer = phase === "shown"
      ? setTimeout(() => setPhase("leaving"), Math.max(0, shownAt.current + min - Date.now()))
      : setTimeout(() => setPhase(null), exit);
    return () => clearTimeout(timer);
  }, [show, phase, min, exit]);
  return phase;
}

/**
 * The agent at work where its next words will appear: its face doing what it
 * is doing, three blocks assembling beside it, what it's on, and the passage
 * it's on, one click from view. Takes the place of a bare caret whenever no
 * text is arriving.
 */
export const AgentWorking = memo(function AgentWorking({
  state,
  expression,
  label,
  since,
  leaving = false,
  target = null,
}: {
  state: InlineActivityState;
  expression?: AgentExpression;
  label: string;
  /** When the work began; the indicator counts from here. */
  since: number;
  leaving?: boolean;
  /** The passage the agent is working on, named and shown in the note on click. */
  target?: { name: string; onShow: () => void } | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <div className="agent-working" data-state={state} data-leaving={leaving || undefined}>
      <span className="agent-working-figure" aria-hidden="true">
        <InlineAgentFace state={state} expression={expression} />
        <span className="agent-working-blocks">
          <i />
          <i />
          <i />
        </span>
      </span>
      <span className="agent-working-label">
        {label.replace(/…$/, "")}
        {target && (
          <>
            {" · "}
            <button type="button" className="agent-working-target" title="Show in note" onClick={target.onShow}>
              {target.name}
            </button>
          </>
        )}
        {elapsed >= SHOW_ELAPSED_AFTER && (
          <span className="agent-working-elapsed"> · {elapsed}s</span>
        )}
      </span>
    </div>
  );
});
