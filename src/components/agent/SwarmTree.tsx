import { memo, useState, type CSSProperties } from "react";
import type { SwarmItem, SwarmWorker } from "../../context/AgentContext";
import type { SubagentStatus, SwarmBoardEntry } from "../../services/agent";
import { StopIcon } from "../icons";

const ACTIVE_STATUSES = new Set<SubagentStatus>([
  "spawning",
  "running",
  "checking",
  "draining",
]);

export function isWorkerActive(status: SubagentStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

function statusLabel(status: SubagentStatus): string {
  switch (status) {
    case "spawning":
      return "Starting";
    case "running":
      return "Running";
    case "checking":
      return "Checking";
    case "draining":
      return "Draining";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "cleaned_up":
      return "Cleaned up";
  }
}

function shortModel(model: string | null | undefined): string | null {
  if (!model) return null;
  return model.startsWith("agy:") ? model.slice(4) : model;
}

function coordinatorSummary(workers: SwarmWorker[]): {
  label: string;
  state: "running" | "checking" | "draining" | "settled" | "cleaned";
} {
  const total = workers.length;
  const checking = workers.filter((w) => w.status === "checking").length;
  const draining = workers.filter((w) => w.status === "draining").length;
  const active = workers.filter((w) => isWorkerActive(w.status)).length;
  const cleaned = workers.filter((w) => w.status === "cleaned_up").length;
  const completed = workers.filter((w) => w.status === "completed").length;
  const failed = workers.filter((w) => w.status === "failed").length;
  const stopped = workers.filter((w) => w.status === "stopped").length;

  if (checking > 0) {
    return {
      label: `Checking on ${checking} of ${total} ${total === 1 ? "agent" : "agents"}`,
      state: "checking",
    };
  }
  if (draining > 0) {
    return {
      label: `Draining ${active} of ${total} ${total === 1 ? "agent" : "agents"}`,
      state: "draining",
    };
  }
  if (active > 0) {
    return {
      label: `Running ${active} of ${total} ${total === 1 ? "agent" : "agents"}`,
      state: "running",
    };
  }
  if (cleaned === total && total > 0) {
    return {
      label: `Cleaned up · ${total} ${total === 1 ? "agent" : "agents"}`,
      state: "cleaned",
    };
  }
  const parts: string[] = [];
  if (completed > 0) parts.push(`${completed} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (stopped > 0) parts.push(`${stopped} stopped`);
  if (cleaned > 0) parts.push(`${cleaned} cleaned`);
  return {
    label: parts.length ? parts.join(" · ") : `${total} ${total === 1 ? "agent" : "agents"}`,
    state: "settled",
  };
}

const BOARD_SECTIONS: Array<{ kind: SwarmBoardEntry["kind"]; heading: string; noun: [string, string] }> = [
  { kind: "decision", heading: "Decisions", noun: ["decision", "decisions"] },
  { kind: "handoff", heading: "Handoffs", noun: ["handoff", "handoffs"] },
  { kind: "question", heading: "Questions", noun: ["question", "questions"] },
  { kind: "update", heading: "Updates", noun: ["update", "updates"] },
];

/** The run's shared board, grouped like the Markdown document the agents read. */
export function SwarmBoard({ entries }: { entries: SwarmBoardEntry[] }) {
  const sections = BOARD_SECTIONS.map((section) => ({
    ...section,
    entries: entries.filter((entry) => entry.kind === section.kind),
  })).filter((section) => section.entries.length > 0);
  const counts = sections
    .map(({ entries: list, noun }) => `${list.length} ${noun[list.length === 1 ? 0 : 1]}`)
    .join(" · ");
  return (
    <details className="agent-swarm-board">
      <summary>Board · {counts}</summary>
      {sections.map((section) => (
        <section key={section.kind} className="agent-swarm-board-section" data-kind={section.kind}>
          <h4>{section.heading}</h4>
          <ul role="list">
            {section.entries.map((entry, index) => (
              <li
                key={`${entry.timestampMs}-${index}`}
                style={entry.color ? ({ "--worker-color": entry.color } as CSSProperties) : undefined}
              >
                <span className="agent-swarm-board-from">{entry.from}</span>
                <span className="agent-swarm-board-message">{entry.message}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </details>
  );
}

function outcomeTone(outcome: string): "pass" | "issues" | "blocked" {
  const upper = outcome.toUpperCase();
  if (upper === "PASS") return "pass";
  if (upper === "BLOCKED") return "blocked";
  return "issues";
}

export const SwarmTree = memo(function SwarmTree({
  swarm,
  activeRun,
  onStopWorker,
  onStopAll,
  onDrain,
  onCleanup,
}: {
  swarm: SwarmItem;
  activeRun: boolean;
  onStopWorker: (runId: string, workerId: string) => void;
  onStopAll: (runId: string) => void;
  onDrain: (runId: string) => void;
  onCleanup: (runId: string, swarmId: string) => void;
}) {
  const { workers } = swarm;
  const summary = coordinatorSummary(workers);
  const hasActive = workers.some((w) => isWorkerActive(w.status));
  const allCleaned = workers.length > 0 && workers.every((w) => w.status === "cleaned_up");
  const canControlActive = activeRun && hasActive;
  const canCleanup = !hasActive && !allCleaned && workers.length > 0;
  const [expandedWhenCleaned, setExpandedWhenCleaned] = useState(false);
  const showBranches = !allCleaned || expandedWhenCleaned;

  return (
    <section
      className="agent-swarm"
      data-state={summary.state}
      aria-label={`Agent swarm: ${swarm.goal ?? summary.label}`}
    >
      <div className="agent-swarm-coordinator">
        <div className="agent-swarm-coord-head">
          <span className="agent-swarm-dot" data-status={summary.state} aria-hidden="true" />
          <span className="agent-swarm-coord-title">Coordinator</span>
          <span className="agent-swarm-coord-summary">{summary.label}</span>
          <div className="agent-swarm-actions">
            {canControlActive && (
              <>
                <button
                  type="button"
                  className="agent-swarm-btn"
                  title="Collect finished results now and stop remaining workers"
                  onClick={() => onDrain(swarm.runId)}
                >
                  Drain
                </button>
                <button
                  type="button"
                  className="agent-swarm-btn agent-swarm-btn-danger"
                  title="Stop all running subagents immediately"
                  onClick={() => onStopAll(swarm.runId)}
                >
                  Stop all
                </button>
              </>
            )}
            {canCleanup && (
              <button
                type="button"
                className="agent-swarm-btn"
                title="Clean up finished subagent state"
                onClick={() => onCleanup(swarm.runId, swarm.swarmId)}
              >
                Clean up
              </button>
            )}
            {allCleaned && (
              <button
                type="button"
                className="agent-swarm-btn"
                onClick={() => setExpandedWhenCleaned((open) => !open)}
              >
                {expandedWhenCleaned ? "Hide" : "Inspect"}
              </button>
            )}
          </div>
        </div>
        {swarm.goal && <p className="agent-swarm-goal">{swarm.goal}</p>}
        {swarm.board && swarm.board.length > 0 && <SwarmBoard entries={swarm.board} />}
      </div>

      {showBranches && workers.length > 0 && (
        <ul className="agent-swarm-tree" role="list" aria-label="Subagents">
          {workers.map((worker, index) => {
            const isLast = index === workers.length - 1;
            const workerActive = isWorkerActive(worker.status);
            const modelLabel = shortModel(worker.model);
            const workerStyle = {
              ...(worker.color ? { "--worker-color": worker.color } : {}),
              "--branch-delay": `${index * 180}ms`,
            } as CSSProperties;
            return (
              <li
                key={worker.workerId}
                className="agent-swarm-branch-row"
                data-status={worker.status}
                data-last={isLast || undefined}
                style={workerStyle}
              >
                <div className="agent-swarm-connector" aria-hidden="true">
                  {!isLast && <span className="agent-swarm-trunk-tail" />}
                  <svg
                    className="agent-swarm-connector-svg"
                    width="24"
                    height="26"
                    viewBox="0 0 24 26"
                  >
                    <path
                      className="agent-swarm-line-elbow"
                      d="M 12 0 L 12 16 Q 12 22 18 22 L 24 22"
                    />
                    {workerActive && (
                      <g className="agent-swarm-orb-group" opacity="0">
                        <circle className="agent-swarm-orb-glow" r="5.5" cx="0" cy="0" />
                        <circle className="agent-swarm-orb" r="2.75" cx="0" cy="0" />
                        <animateMotion
                          dur="1.25s"
                          begin={`${index * 180}ms`}
                          repeatCount="indefinite"
                          calcMode="spline"
                          keyTimes="0;1"
                          keySplines="0.4 0 0.2 1"
                          path="M 12 0 L 12 16 Q 12 22 18 22 L 26 22"
                        />
                        <animate
                          attributeName="opacity"
                          dur="1.25s"
                          begin={`${index * 180}ms`}
                          repeatCount="indefinite"
                          keyTimes="0;0.12;0.85;1"
                          values="0;1;1;0"
                        />
                      </g>
                    )}
                  </svg>
                </div>

                <div className="agent-swarm-worker" data-status={worker.status}>
                  <div className="agent-swarm-worker-head">
                    <span
                      className="agent-swarm-dot"
                      data-status={worker.status}
                      aria-hidden="true"
                    />
                    <span className="agent-swarm-worker-name">{worker.name}</span>
                    {worker.role && worker.role !== "Subagent" && (
                      <span className="agent-swarm-worker-role">{worker.role}</span>
                    )}
                    {worker.section && (
                      <span className="agent-swarm-section" title={`Claimed section: ${worker.section}`}>
                        § {worker.section}
                      </span>
                    )}
                    {modelLabel && (
                      <span className="agent-swarm-model">{modelLabel}</span>
                    )}
                    <div className="agent-swarm-worker-tail">
                      {worker.outcome && (
                        <span
                          className="agent-swarm-outcome"
                          data-tone={outcomeTone(worker.outcome)}
                        >
                          {worker.outcome}
                        </span>
                      )}
                      {worker.status === "checking" && (
                        <span className="agent-swarm-pill">Checked</span>
                      )}
                      {activeRun && workerActive && (
                        <button
                          type="button"
                          className="agent-swarm-stop-one"
                          aria-label={`Stop ${worker.name}`}
                          title={`Stop ${worker.name}`}
                          onClick={() => onStopWorker(swarm.runId, worker.workerId)}
                        >
                          <StopIcon className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="agent-swarm-worker-meta">
                    <span className="agent-swarm-status-text">
                      {statusLabel(worker.status)}
                    </span>
                    {worker.activity && worker.activity !== statusLabel(worker.status) && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">{worker.activity}</span>
                      </>
                    )}
                    {worker.steps > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          {worker.steps} {worker.steps === 1 ? "step" : "steps"}
                        </span>
                      </>
                    )}
                    {worker.checkedAt && worker.status !== "checking" && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>Checked</span>
                      </>
                    )}
                  </div>

                  {worker.output && (
                    <details className="agent-swarm-output">
                      <summary>View report</summary>
                      <pre>{worker.output}</pre>
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
});
