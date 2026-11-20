import { createContext, useContext } from "react";
import { defineRegistry, useBoundProp } from "@json-render/react";
import { catalog } from "../../../lib/agent/ui/catalog";
import { cn } from "../../../lib/utils";
import { isProjectFileId, openFile } from "../../../services/projects";
import { TraceOutcomeView, TraceStepView, WritingSuggestionView } from "./writingOfferContext";

/** Lets NoteLink open a note without the model wiring an action. Project files open in their own window. */
export const OpenNoteContext = createContext<(id: string) => void>(() => {});

/**
 * Sends a suggested next move as the user's message. Null leaves the buttons
 * inert: only the latest reply's suggestions are live, and not during a run.
 */
export const SuggestionContext = createContext<((message: string) => void) | null>(null);
const MAX_SUGGESTIONS = 4;

function SuggestionsView({ items }: { items: string[] }) {
  const send = useContext(SuggestionContext);
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested next steps">
      {items.map((item) => (
        <button key={item} type="button" className="agent-panel-chip" disabled={!send} onClick={() => send?.(item)}>
          {item}
        </button>
      ))}
    </div>
  );
}

const GAP = { sm: "gap-1.5", md: "gap-3", lg: "gap-4" } as const;
const CALLOUT_TONE = {
  info: "border-border bg-bg-muted",
  warning: "border-amber-500/40 bg-amber-500/10",
  success: "border-emerald-500/40 bg-emerald-500/10",
} as const;

// Generated props are only structurally validated, so read them defensively.
const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) =>
  value === null || value === undefined ? "" : String(value);

function NoteLinkView({
  id,
  title,
  detail,
}: {
  id: string;
  title: string;
  detail: string | null;
}) {
  const openNote = useContext(OpenNoteContext);
  return (
    <button
      type="button"
      className="agent-ui-notelink"
      onClick={() => (isProjectFileId(id) ? void openFile(id).catch(() => {}) : openNote(id))}
      title={`Open ${title}`}
    >
      <span className="font-medium text-text">{title}</span>
      {detail && <span className="text-text-muted">{detail}</span>}
    </button>
  );
}

export const { registry } = defineRegistry(catalog, {
  components: {
    Stack: ({ props, children }) => (
      <div
        className={cn(
          "flex min-w-0",
          props.direction === "horizontal" ? "flex-row flex-wrap" : "flex-col",
          GAP[props.gap ?? "md"] ?? GAP.md,
        )}
      >
        {children}
      </div>
    ),
    Card: ({ props, children }) => (
      <section className="agent-ui-card">
        {props.title && (
          <h4 className="text-xs font-medium text-text">{text(props.title)}</h4>
        )}
        {children}
      </section>
    ),
    Heading: ({ props }) => (
      <h4 className="text-xs font-semibold text-text">{text(props.text)}</h4>
    ),
    Text: ({ props }) => (
      <p
        className={cn(
          "text-xs leading-relaxed whitespace-pre-wrap",
          props.tone === "muted" ? "text-text-muted" : "text-text",
        )}
      >
        {text(props.text)}
      </p>
    ),
    List: ({ props }) => {
      const Tag = props.ordered ? "ol" : "ul";
      return (
        <Tag
          className={cn(
            "text-xs leading-relaxed pl-4 space-y-0.5",
            props.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {list<unknown>(props.items).map((item, index) => (
            <li key={index}>{text(item)}</li>
          ))}
        </Tag>
      );
    },
    Table: ({ props }) => (
      <div className="agent-ui-table">
        <table>
          <thead>
            <tr>
              {list<unknown>(props.columns).map((column, index) => (
                <th key={index}>{text(column)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list<unknown>(props.rows).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {list<unknown>(row).map((cell, cellIndex) => (
                  <td key={cellIndex}>{text(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
    KeyValue: ({ props }) => (
      <dl className="agent-ui-keyvalue">
        {list<{ label?: unknown; value?: unknown }>(props.items).map(
          (item, index) => (
            <div key={index}>
              <dt>{text(item?.label)}</dt>
              <dd>{text(item?.value)}</dd>
            </div>
          ),
        )}
      </dl>
    ),
    Checklist: ({ props }) => (
      <ul className="space-y-1 text-xs">
        {list<{ label?: unknown; done?: unknown }>(props.items).map(
          (item, index) => (
            <li key={index} className="flex items-start gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 h-3 w-3 shrink-0 rounded-[3px] border",
                  item?.done ? "border-accent bg-accent" : "border-border",
                )}
              />
              <span className={cn(item?.done === true && "text-text-muted line-through")}>
                <span className="sr-only">{item?.done ? "Done: " : "To do: "}</span>
                {text(item?.label)}
              </span>
            </li>
          ),
        )}
      </ul>
    ),
    Callout: ({ props }) => (
      <div
        role="note"
        className={cn(
          "rounded-lg border px-3 py-2 text-xs leading-relaxed",
          CALLOUT_TONE[props.tone] ?? CALLOUT_TONE.info,
        )}
      >
        {props.title && <p className="font-medium">{text(props.title)}</p>}
        <p>{text(props.text)}</p>
      </div>
    ),
    NoteLink: ({ props }) => (
      <NoteLinkView
        id={text(props.id)}
        title={text(props.title)}
        detail={props.detail ? text(props.detail) : null}
      />
    ),
    // What is shown is exactly what is sent: a suggestion carries no hidden prompt.
    Suggestions: ({ props }) => (
      <SuggestionsView items={list<unknown>(props.items).map(text).map((item) => item.trim()).filter(Boolean).slice(0, MAX_SUGGESTIONS)} />
    ),
    WritingSuggestion: ({ props }) => <WritingSuggestionView id={typeof props.id === "string" ? props.id : ""} />,
    TraceStep: ({ props }) => (
      <TraceStepView
        offerId={typeof props.offerId === "string" ? props.offerId : null}
        step={typeof props.step === "number" ? props.step : -1}
      />
    ),
    TraceOutcome: ({ props }) => (
      <TraceOutcomeView offerId={typeof props.offerId === "string" ? props.offerId : null} />
    ),
    Choice: ({ props, bindings }) => {
      const [value, setValue] = useBoundProp<string | string[] | null>(
        props.value,
        bindings?.value,
      );
      const selected = Array.isArray(value) ? value : value ? [value] : [];
      const options = list<{
        value?: unknown;
        label?: unknown;
        description?: unknown;
      }>(props.options);
      return (
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-xs font-medium">{text(props.label)}</legend>
          {options.map((option, index) => {
            const optionValue = text(option?.value);
            const checked = selected.includes(optionValue);
            return (
              <label key={index} className="agent-ui-option" data-checked={checked}>
                <input
                  type={props.multiple ? "checkbox" : "radio"}
                  className="sr-only"
                  checked={checked}
                  onChange={() =>
                    setValue(
                      props.multiple
                        ? checked
                          ? selected.filter((item) => item !== optionValue)
                          : [...selected, optionValue]
                        : optionValue,
                    )
                  }
                />
                <span className="font-medium">{text(option?.label)}</span>
                {option?.description ? (
                  <span className="text-text-muted">{text(option.description)}</span>
                ) : null}
              </label>
            );
          })}
        </fieldset>
      );
    },
    TextField: ({ props, bindings }) => {
      const [value, setValue] = useBoundProp<string | null>(
        props.value,
        bindings?.value,
      );
      const Field = props.multiline ? "textarea" : "input";
      return (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium">{text(props.label)}</span>
          <Field
            className="agent-ui-field"
            value={value ?? ""}
            placeholder={props.placeholder ?? undefined}
            rows={props.multiline ? 3 : undefined}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
      );
    },
    Toggle: ({ props, bindings }) => {
      const [value, setValue] = useBoundProp<boolean | null>(
        props.value,
        bindings?.value,
      );
      return (
        <label className="flex items-center justify-between gap-3 text-xs">
          <span className="font-medium">{text(props.label)}</span>
          <input
            type="checkbox"
            role="switch"
            className="accent-[var(--color-accent)]"
            checked={!!value}
            onChange={(event) => setValue(event.target.checked)}
          />
        </label>
      );
    },
  },
});
