import { memo, useMemo } from "react";
import { createStateStore } from "@json-render/core";
import type { QuestionAnswer, QuestionItem } from "../../context/AgentContext";
import { AgentSpec } from "./ui/AgentSpec";

/**
 * An ask_user question. While the run waits it takes an answer from its form,
 * an option, or the composer; afterwards it collapses to what was answered.
 */
export const AgentQuestion = memo(function AgentQuestion({
  item,
  pending,
  onAnswer,
}: {
  item: QuestionItem;
  pending: boolean;
  onAnswer: (answer: QuestionAnswer) => void;
}) {
  const store = useMemo(
    () =>
      item.form
        ? createStateStore(
            (item.form as { state?: Record<string, unknown> }).state ?? {},
          )
        : null,
    [item.form],
  );
  const submitForm = () => {
    if (!store) return;
    const state = store.getSnapshot();
    const answers = state.answers;
    onAnswer(
      answers && typeof answers === "object" && !Array.isArray(answers)
        ? (answers as Record<string, unknown>)
        : state,
    );
  };
  return (
    <section
      className="agent-panel-question"
      data-pending={pending}
      aria-label="Question from ChatGPT"
    >
      <p className="text-xs font-medium leading-relaxed">{item.question}</p>
      {item.answer !== null ? (
        <p className="text-xs text-text-muted">
          You answered: <span className="text-text">{item.answer}</span>
        </p>
      ) : !pending ? (
        <p className="text-xs text-text-muted">Not answered.</p>
      ) : item.form && store ? (
        <>
          <AgentSpec spec={item.form} store={store} />
          <div className="flex justify-end">
            <button
              type="button"
              className="agent-panel-primary"
              onClick={submitForm}
            >
              Send answer
            </button>
          </div>
        </>
      ) : (
        <>
          {item.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {item.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="agent-panel-chip"
                  onClick={() => onAnswer(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <p className="text-[10px] text-text-muted">
            {item.options.length
              ? "Or type a different answer below."
              : "Type your answer below."}
          </p>
        </>
      )}
    </section>
  );
});
