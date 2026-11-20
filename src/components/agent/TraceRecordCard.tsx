import { memo, useMemo } from "react";
import type { TraceRecord } from "../../lib/agent/traceRecord";
import { isConvergentTrace, traceBranches } from "../../lib/agent/writingOffers";
import { argumentMapSpec } from "../../lib/agent/ui/argumentMapSpec";
import { AgentSpec } from "./ui/AgentSpec";
import { surfaceFromRecord, TraceOutcomeItem, TraceStepItem, TraceSurfaceContext } from "./ui/writingOfferContext";
import "./WritingOfferCard.css";

/** An argument map kept in the conversation: how the agent got there, its converging branches, and what the writer corrected. */
export const TraceRecordCard = memo(function TraceRecordCard({ record }: { record: TraceRecord }) {
  const { offer, outcome, corrections, confirmed } = record;
  const subject = outcome?.text ?? offer.quote;
  const surface = useMemo(() => surfaceFromRecord(record), [record]);
  const convergent = isConvergentTrace(offer.trace) || !!offer.view;
  const branchCount = useMemo(() => (convergent ? traceBranches(offer.trace).length : 1), [convergent, offer.trace]);
  const spec = useMemo(() => (convergent ? argumentMapSpec({
    offerId: surface.id,
    trace: offer.trace,
    provenance: surface.provenance,
    numbers: surface.numbers,
    view: offer.view,
  }) : null), [convergent, surface, offer.trace, offer.view]);

  return (
    <details className="agent-trace-record">
      <summary>
        <span className="agent-trace-record-diamond" aria-hidden="true" />
        <span className="truncate">{outcome ? "Traced back from" : "Traced to"} “{subject}”</span>
        <span className="agent-trace-record-meta">
          {offer.trace.length} {offer.trace.length === 1 ? "step" : "steps"}
          {branchCount > 1 && ` · ${branchCount} threads`}
          {!!confirmed?.length && ` · ${confirmed.length} confirmed`}
          {corrections.length > 0 && ` · ${corrections.length} corrected`}
        </span>
      </summary>
      {spec ? (
        <TraceSurfaceContext.Provider value={surface}>
          <div className="argument-map-genui" aria-label="How we got there">
            <AgentSpec spec={spec} />
          </div>
        </TraceSurfaceContext.Provider>
      ) : (
        <ol className="argument-map-steps" aria-label="How we got there">
          {offer.trace.map((step, index) => (
            <TraceStepItem key={`${index}:${step.quote}`} surface={surface} index={index} as="li" />
          ))}
          <TraceOutcomeItem surface={surface} as="li" />
        </ol>
      )}
    </details>
  );
});
