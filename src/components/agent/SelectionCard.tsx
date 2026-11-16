import { memo } from "react";
import type { SelectionSummary } from "../../lib/agent/selection";
import { XIcon } from "../icons";
import { MarkdownPreview } from "./AgentMarkdown";

/** The selection the agent will work with (or is working with), as the user wrote it. */
export const SelectionCard = memo(function SelectionCard({
  summary,
  running,
  onReveal,
  onClear,
}: {
  summary: SelectionSummary;
  running: boolean;
  onReveal: () => void;
  onClear: () => void;
}) {
  const words = `${summary.words.toLocaleString()} ${summary.words === 1 ? "word" : "words"}`;
  return (
    <div className="agent-selection-card">
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
      <div className="agent-selection-meta">
        <span className="truncate">
          {running ? "Working on" : "Selection"} · {words}
          {summary.section && <> · in {summary.section}</>}
        </span>
        {!running && (
          <button
            type="button"
            className="agent-selection-clear"
            aria-label="Clear selection"
            title="Clear selection"
            onClick={onClear}
          >
            <XIcon className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
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
