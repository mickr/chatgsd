import { memo, useState } from "react";
import type { TraceRecord } from "../../lib/agent/traceRecord";
import { OffPageStep, PROVENANCE as SOURCE, stepNumbers } from "./ui/writingOfferContext";
import "./WritingOfferCard.css";

/** An argument map kept in the conversation: how the agent got there, what was learned, and what the writer corrected. */
export const TraceRecordCard = memo(function TraceRecordCard({ record }: { record: TraceRecord }) {
  const { offer, outcome, provenance, corrections } = record;
  const subject = outcome?.text ?? offer.quote;
  const numbers = stepNumbers(record.anchored ?? provenance.map(source => !source));
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <details className="agent-trace-record">
      <summary>
        <span className="agent-trace-record-diamond" aria-hidden="true" />
        <span className="truncate">{outcome ? "Traced back from" : "Traced to"} “{subject}”</span>
        <span className="agent-trace-record-meta">
          {offer.trace.length} {offer.trace.length === 1 ? "step" : "steps"}
          {corrections.length > 0 && ` · ${corrections.length} corrected`}
        </span>
      </summary>
      <ol className="argument-map-steps" aria-label="How we got there">
        {offer.trace.map((step, index) => {
          const source = provenance[index];
          const correction = [...corrections].reverse().find(item => item.step === index);
          return <li key={`${index}:${step.quote}`} data-unsure={!step.sure || undefined} data-source={source?.kind}
            data-offpage={numbers[index] ? undefined : true}>
            <span className="argument-map-steps-number" aria-hidden="true">{numbers[index] ?? ""}</span>
            <div className="argument-map-steps-body">
              {source && <span className="argument-map-steps-source"><strong>{SOURCE[source.kind]}</strong>
                {source.kind === "you" ? "" : ` · ${source.label.replace(/^Research: /, "")}`}</span>}
              {numbers[index] ? <span className="argument-map-steps-quote">{step.quote}</span>
                : <OffPageStep entry={source} quote={step.quote} expanded={expanded === index}
                  onExpand={() => setExpanded(expanded === index ? null : index)} />}
              <p>{!step.sure && <span className="argument-map-steps-unsure">I assumed this · </span>}{step.reading}</p>
              {correction && <p className="agent-trace-record-correction"><strong>You meant:</strong> {correction.meant}</p>}
            </div>
          </li>;
        })}
        <li data-decision>
          <span className="argument-map-steps-number" aria-hidden="true" />
          <div className="argument-map-steps-body">
            <p><strong>What we learned:</strong> {offer.explanation}</p>
            {offer.question && <p>{offer.question}</p>}
          </div>
        </li>
      </ol>
    </details>
  );
});
