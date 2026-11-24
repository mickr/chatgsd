import { memo, useState } from "react";
import type { QuestionAnswer, TranscriptItem } from "../../context/AgentContext";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentQuestion } from "./AgentQuestion";
import { TraceRecordCard } from "./TraceRecordCard";
import { SelectionQuote } from "./SelectionCard";
import { SkillOfferCard, sourceHost } from "./SkillOfferCard";
import { SwarmTree } from "./SwarmTree";
/** " (lines 120–260)" for a ranged read, otherwise nothing. */
function lineRange(input: Record<string, unknown>) {
  const start = typeof input.start_line === "number" ? input.start_line : null;
  const end = typeof input.end_line === "number" ? input.end_line : null;
  if (start === null && end === null) return "";
  return ` (lines ${start ?? 1}–${end ?? "end"})`;
}
function toolLabel(item: Extract<TranscriptItem, { type: "tool" }>) {
  const input =
    item.input && typeof item.input === "object"
      ? (item.input as Record<string, unknown>)
      : {};
  if (item.name === "remember_work") return item.ok === false ? "Couldn’t save memory" : item.ok ? "Saved for this note" : "Saving for this note";
  if (item.name === "read_document") return `Read note${lineRange(input)}`;
  if (item.name === "replace_selection")
    return item.ok ? "Edited selection" : "Edit selection";
  if (item.name === "edit_document") {
    const count = Array.isArray(input.edits) ? input.edits.length : 1;
    return `${item.ok ? "Edited" : "Edit"} ${count} ${count === 1 ? "place" : "places"}`;
  }
  if (item.name === "edit_note")
    return `${item.ok ? "Edited" : "Edit"} note: ${String(input.id ?? "")}`;
  if (item.name === "search_notes")
    return `Search: ${String(input.query ?? "notes")}`;
  if (item.name === "list_notes")
    return input.folder ? `Listed notes in ${String(input.folder)}` : "Listed notes";
  if (item.name === "list_projects")
    return input.path ? `Looked in ${String(input.path)}` : "Looked at projects";
  if (item.name === "search_projects")
    return `Search ${input.project ? String(input.project) : "projects"}: ${String(input.query ?? "")}`;
  if (item.name === "read_notes") {
    const ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
    return ids.length
      ? `Read: ${ids.join(", ")}${lineRange(input)}`
      : "Read notes";
  }
  if (item.name === "find_in_note")
    return `Find “${String(input.query ?? "")}”${input.id ? ` in ${String(input.id)}` : ""}`;
  if (item.name === "note_links")
    return input.id ? `Links: ${String(input.id)}` : "Links for this note";
  if (item.name === "research")
    return `Research: ${String(input.question ?? "the web")}`;
  if (item.name === "web_search") {
    if (input.type === "open_page") return `Opened ${sourceHost(String(input.url ?? ""))}`;
    if (input.type === "find_in_page") return `Searched in ${sourceHost(String(input.url ?? ""))}`;
    const queries = Array.isArray(input.queries) ? input.queries.map(String) : [];
    return queries.length ? `Searched: ${queries.join("; ")}` : "Searched the web";
  }
  if (item.name === "web_fetch")
    return `Read ${sourceHost(String(input.url ?? ""))}${lineRange(input)}`;
  if (item.name === "mcp_tools")
    return `Checked what ${String(input.server ?? "a service")} can do`;
  if (item.name === "mcp_call")
    return `${String(input.server ?? "Service")}: ${String(input.tool ?? "").replace(/_/g, " ")}`;
  if (item.name === "read_skill")
    return `Used skill: ${String(input.name ?? "")}`;
  if (item.name === "offer_skill")
    return item.ok === false ? "Couldn't offer a skill" : "Offered a skill";
  if (item.name === "shell_command" || item.name === "run_command") {
    const cmd = typeof input.command === "string"
      ? input.command
      : typeof input.CommandLine === "string"
        ? input.CommandLine
        : "";
    const short = cmd.replace(/\s+/g, " ").trim();
    return short ? `Run: ${short.length > 64 ? `${short.slice(0, 63)}…` : short}` : "Run command";
  }
  if (item.name === "spawn_subagents") {
    const count = Array.isArray(input.workers) ? input.workers.length : 1;
    const goal = typeof input.goal === "string" && input.goal.trim() ? `: ${input.goal.trim()}` : "";
    return `${item.ok ? "Fanned out" : "Fanning out"} ${count} ${count === 1 ? "agent" : "agents"}${goal}`;
  }
  if (item.name === "check_subagents")
    return item.ok ? "Checked on agents" : "Checking on agents";
  if (item.name === "drain_subagents")
    return item.ok ? "Drained agents" : "Draining agents";
  if (item.name === "stop_subagents")
    return input.cleanup ? "Cleaned up agents" : "Stopped agents";
  if (item.name === "swarm_message")
    return input.action === "post" ? "Posted to the swarm board" : "Read the swarm board";
  return item.name.replace(/_/g, " ");
}
/** User messages longer than this start collapsed. */
const USER_CLAMP_CHARS = 1200;
const USER_CLAMP_LINES = 14;
function UserMessage({ text, selection }: { text: string; selection?: string }) {
  const long =
    text.length > USER_CLAMP_CHARS ||
    text.split("\n", USER_CLAMP_LINES + 1).length > USER_CLAMP_LINES;
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="agent-panel-user"
      data-clamped={(long && !expanded) || undefined}
    >
      {selection && <SelectionQuote markdown={selection} />}
      <p>{text}</p>
      {long && (
        <button
          type="button"
          className="agent-panel-link agent-panel-link-quiet"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : `Show all ${text.length.toLocaleString()} characters`}
        </button>
      )}
    </div>
  );
}
export const AgentMessage = memo(function AgentMessage({
  item,
  streaming,
  active,
  pendingQuestionId,
  onAnswer,
  onDismissOffer,
  onStopSubagent,
  onStopAllSubagents,
  onDrainSubagents,
  onCleanupSubagents,
}: {
  item: TranscriptItem;
  streaming: boolean;
  active: boolean;
  pendingQuestionId: string | null;
  onAnswer: (answer: QuestionAnswer) => void;
  onDismissOffer: (id: string) => void;
  onStopSubagent?: (runId: string, workerId: string) => void;
  onStopAllSubagents?: (runId: string) => void;
  onDrainSubagents?: (runId: string) => void;
  onCleanupSubagents?: (runId: string, swarmId: string) => void;
}) {
  if (item.type === "changes") return null;
  if (item.type === "thinking")
    return (
      <details className="agent-panel-thinking" open={streaming || undefined}>
        <summary>
          <span
            className={`agent-panel-tool-dot ${streaming ? "bg-accent animate-pulse" : "bg-text-muted"}`}
          />
          <span>{streaming ? "Thinking…" : "Thought process"}</span>
        </summary>
        <div className="agent-panel-thinking-body">{item.text}</div>
      </details>
    );
  if (item.type === "swarm")
    return (
      <SwarmTree
        swarm={item}
        activeRun={active}
        onStopWorker={(runId, workerId) => onStopSubagent?.(runId, workerId)}
        onStopAll={(runId) => onStopAllSubagents?.(runId)}
        onDrain={(runId) => onDrainSubagents?.(runId)}
        onCleanup={(runId, swarmId) => onCleanupSubagents?.(runId, swarmId)}
      />
    );
  if (item.type === "question")
    return (
      <AgentQuestion
        item={item}
        pending={item.id === pendingQuestionId}
        onAnswer={onAnswer}
      />
    );
  if (item.type === "skill_offer")
    return (
      <SkillOfferCard
        offer={item}
        dismissed={item.dismissed}
        onDismiss={() => onDismissOffer(item.id)}
      />
    );
  if (item.type === "activity")
    return <p className="text-xs text-text-muted">{item.text}</p>;
  if (item.type === "trace") return <TraceRecordCard record={item} />;
  if (item.type === "tool")
    return (
      <details className="agent-panel-tool">
        <summary>
          <span
            className={`agent-panel-tool-dot ${item.ok === false ? "bg-red-500" : item.ok ? "bg-accent" : active ? "bg-text-muted animate-pulse" : "bg-text-muted"}`}
          />
          <span className="truncate">{toolLabel(item)}</span>
          <span className="ml-auto text-[10px] text-text-muted">
            {item.ok === false
              ? "Failed"
              : item.output === undefined
                ? active ? "Running" : "Result not saved"
                : "Details"}
          </span>
        </summary>
        <pre>{item.output ?? (active
          ? JSON.stringify(item.input, null, 2)
          : "This turn ended before a tool result was saved. Any recorded edits are shown below.")}</pre>
      </details>
    );
  if (item.type === "user")
    return <UserMessage text={item.text} selection={item.selection} />;
  return <AgentMarkdown text={item.text} streaming={streaming} />;
});
