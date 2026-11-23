import { memo, type ComponentType } from "react";
import type { SelectionSummary } from "../../lib/agent/selection";
import { XIcon } from "../icons";
import { MarkdownPreview } from "./AgentMarkdown";

export type SelectionAction = {
  label: string;
  icon: ComponentType<{ className?: string }>;
  onSelect: () => void;
};

/**
 * The selection the agent will work with (or is working with), docked on the
 * composer as the user wrote it, with what the agent can do with it. The first
 * action leads; the rest are quieter alternatives.
 */
export const SelectionCard = memo(function SelectionCard({
  summary,
  running,
  onReveal,
  onClear,
  actions = [],
  busy = false,
}: {
  summary: SelectionSummary;
  running: boolean;
  onReveal: () => void;
  onClear: () => void;
  /** Empty while the agent can't be asked about the passage. */
  actions?: SelectionAction[];
  busy?: boolean;
}) {
  const words = `${summary.words.toLocaleString()} ${summary.words === 1 ? "word" : "words"}`;
  return (
    <section
      className="agent-selection-card"
      data-running={running || undefined}
      aria-label={running ? "Passage the agent is working on" : "Selected passage"}
    >
      <div className="agent-selection-head">
        <button
          type="button"
          className="agent-selection-preview"
          data-clipped={summary.clipped || undefined}
          onClick={onReveal}
          disabled={!summary.range}
          title={summary.range ? "Show in note" : undefined}
        >
          <MarkdownPreview text={summary.markdown} />
        </button>
        {!running && (
          <button
            type="button"
            className="agent-selection-clear"
            aria-label="Clear selection"
            title="Clear selection (Esc)"
            onClick={onClear}
          >
            <XIcon className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className="agent-selection-meta truncate">
        {running ? "Working on" : "Selection"} · {words}
        {summary.section && <> · in {summary.section}</>}
      </div>
      {!running && actions.length > 0 && (
        <div className="agent-selection-actions" role="group" aria-label="Work with this passage">
          {actions.map(({ label, icon: Icon, onSelect }, index) => (
            <button
              type="button"
              key={label}
              data-primary={index === 0 || undefined}
              disabled={busy}
              onClick={onSelect}
            >
              <Icon className="w-3 h-3 shrink-0" />
              {label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
});

/** The selection a message was sent with, shown above it in the transcript. */
export const SelectionQuote = memo(function SelectionQuote({
  markdown,
}: {
  markdown: string;
}) {
  return (
    <blockquote className="agent-selection-quote">
      <MarkdownPreview text={markdown} />
    </blockquote>
  );
});
