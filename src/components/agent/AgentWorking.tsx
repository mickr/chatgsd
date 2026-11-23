import { memo, useEffect, useState } from "react";
import type { AgentExpression } from "../../services/agent";
import type { InlineActivityState } from "./InlineAgentActivity";
import { InlineAgentFace } from "./InlineAgentFace";
import "./AgentWorking.css";

/** Seconds of work before the indicator starts counting, so quick answers stay quiet. */
const SHOW_ELAPSED_AFTER = 4;

/**
 * The agent at work where its next words will appear: its face doing what it
 * is doing, three blocks assembling beside it, and what it's on. Takes the
 * place of a bare caret whenever no text is arriving.
 */
export const AgentWorking = memo(function AgentWorking({
  state,
  expression,
  label,
  since,
}: {
  state: InlineActivityState;
  expression?: AgentExpression;
  label: string;
  /** When the work began; the indicator counts from here. */
  since: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <div className="agent-working" data-state={state}>
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
        {elapsed >= SHOW_ELAPSED_AFTER && (
          <span className="agent-working-elapsed"> · {elapsed}s</span>
        )}
      </span>
    </div>
  );
});
