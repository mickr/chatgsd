import { memo, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import type { SelectionSummary } from "../../lib/agent/selection";
import { XIcon } from "../icons";
import { MarkdownPreview } from "./AgentMarkdown";

export type SelectionAction = {
  /** Shown on the button while there's room; narrower panels show the icon alone. */
  label: string;
  /** The full name, for the tooltip and assistive technology. */
  title: string;
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
  compact = false,
}: {
  summary: SelectionSummary;
  running: boolean;
  onReveal: () => void;
  onClear: () => void;
  /** Empty while the agent can't be asked about the passage. */
  actions?: SelectionAction[];
  busy?: boolean;
  /** The writer is typing about it, so the passage steps back to one line. */
  compact?: boolean;
}) {
  const words = `${summary.words.toLocaleString()} ${summary.words === 1 ? "word" : "words"}`;
  // The preview fades out only when the passage runs past the lines it's given.
  const preview = useRef<HTMLButtonElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const button = preview.current;
    const content = button?.firstElementChild as HTMLElement | null | undefined;
    if (!button || !content) return;
    const measure = () => setOverflows(content.offsetHeight > button.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observer.observe(button);
    return () => observer.disconnect();
  }, [compact]);
  return (
    <section
      className="agent-selection-card"
      data-running={running || undefined}
      data-compact={compact || undefined}
      aria-label={running ? "Passage the agent is working on" : "Selected passage"}
    >
      <div className="agent-selection-head">
        <button
          type="button"
          ref={preview}
          className="agent-selection-preview"
          data-clipped={summary.clipped || overflows || undefined}
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
        {running && "Working on · "}{words}
        {summary.section && <> · {summary.section}</>}
      </div>
      {!running && actions.length > 0 && (
        <div className="agent-selection-actions" role="group" aria-label="Work with this passage">
          {actions.map(({ label, title, icon: Icon, onSelect }, index) => (
            // Lower-ranked actions give up their labels first as the panel narrows.
            <button
              type="button"
              key={title}
              aria-label={title}
              title={title}
              data-primary={index === 0 || undefined}
              data-rank={index}
              disabled={busy}
              onClick={onSelect}
            >
              <Icon className="w-3 h-3 shrink-0" />
              <span className="agent-selection-action-label">{label}</span>
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
