import { memo, useLayoutEffect, useRef, useState, type ComponentType } from "react";

export type AgentAction = {
  /** Shown on the button while there's room; narrower panels show the icon alone. */
  label: string;
  /** The full name, for the tooltip and assistive technology. */
  title: string;
  icon: ComponentType<{ className?: string }>;
  onSelect: () => void;
};

/** The flex gap between buttons, and between a button's icon and label, in CSS. */
const GAP = 4;

/**
 * One row of things the agent can do. The first leads; the rest are quieter.
 * When the row doesn't fit, the last actions give up their labels first, so it
 * stays one line at any panel width without hard-coded breakpoints.
 */
export const AgentActions = memo(function AgentActions({
  actions,
  label,
  busy = false,
}: {
  actions: AgentAction[];
  /** Names the group for assistive technology. */
  label: string;
  busy?: boolean;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [iconOnly, setIconOnly] = useState(0);
  const titles = actions.map((action) => action.title).join("\n");
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const fit = () => {
      if (!element.clientWidth) return; // Not laid out yet (or hidden): nothing to fit.
      // A hidden label stays measurable (it's taken out of the flow, not removed),
      // so each button's full width is known whichever way it's showing now.
      const buttons = [...element.children] as HTMLElement[];
      const labels = buttons.map((button) => ((button.lastElementChild as HTMLElement | null)?.offsetWidth ?? 0) + GAP);
      const widths = buttons.map((button, index) => button.offsetWidth + (button.dataset.iconOnly ? labels[index] : 0));
      let total = widths.reduce((sum, width) => sum + width, 0) + GAP * Math.max(0, widths.length - 1);
      let hidden = 0;
      while (total > element.clientWidth && hidden < widths.length - 1) {
        total -= labels[widths.length - 1 - hidden];
        hidden++;
      }
      setIconOnly(hidden);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [titles]);
  return (
    <div ref={row} className="agent-actions" role="group" aria-label={label}>
      {actions.map(({ label: text, title, icon: Icon, onSelect }, index) => (
        <button
          type="button"
          key={title}
          aria-label={title}
          title={title}
          data-primary={index === 0 || undefined}
          data-icon-only={index >= actions.length - iconOnly || undefined}
          disabled={busy}
          onClick={onSelect}
        >
          <Icon className="w-3 h-3 shrink-0" />
          <span className="agent-action-label">{text}</span>
        </button>
      ))}
    </div>
  );
});
