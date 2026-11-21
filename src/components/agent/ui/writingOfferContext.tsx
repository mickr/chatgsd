import { createContext, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Spec } from "@json-render/core";
import { toast } from "sonner";
import {
  isConvergentTrace,
  traceActivePath,
  traceBranches,
  tracePlaybackOrder,
  type PreparedWritingOffer,
  type WritingOffer,
  type WritingRequest,
} from "../../../lib/agent/writingOffers";
import type { ProvenanceEntry } from "../../../lib/agent/provenance";
import type { TraceConfirmation, TraceCorrection, TraceRecord } from "../../../lib/agent/traceRecord";
import { argumentMapSpec } from "../../../lib/agent/ui/argumentMapSpec";
import { showTranscriptItem } from "../../../lib/agent/transcriptLink";
import { errorMessage } from "../../../services/agent";
import "../WritingOfferCard.css";

export interface WritingOfferControls {
  id: string;
  offer: PreparedWritingOffer;
  stale: boolean;
  busy: boolean;
  /** Shared by the inline and sidebar surfaces when supplied by the provider. */
  draft?: string;
  onDraftChange?: (value: string) => void;
  onAccept: (replacement?: string) => void;
  onAnswer: (answer: string) => void;
  onShow: () => void;
  /** The writer is looking at the card (hover or focus) or has looked away. */
  onHighlight?: (on: boolean) => void;
  onDismiss: () => void;
  onAddToChat: () => void;
  /** The map of how the agent got here: open or not, the step being read, whether it is playing through, and a way to confirm, correct, or verify a step. */
  map?: { open: boolean; active: number | null; playing?: boolean; onPlay?: () => void;
    onToggle: () => void; onFocus: (index: number) => void;
    onRealign: (step: number, correction: string) => void; onConfirm?: (step: number) => void;
    onCheckSource?: (step: number) => void };
}

/** Grounded trace data for rendering TraceStep and TraceOutcome inside GenUI specs or saved records. */
export interface TraceSurface {
  id: string;
  offer: WritingOffer;
  provenance: readonly (ProvenanceEntry | null)[];
  /** An earlier answer that may settle each unsure step, offered beside it until the writer confirms. */
  resolved?: readonly (ProvenanceEntry | null)[];
  confirmedSteps?: readonly boolean[];
  /** Whether each step has a place in the note. A step is numbered by its place in the trace either way. */
  anchored: readonly boolean[];
  /** Note steps whose passage the writer has changed since the map was made. */
  edited?: readonly boolean[];
  requested?: WritingRequest;
  outcome?: { text: string; paragraphs: number } | null;
  corrections?: readonly TraceCorrection[];
  confirmed?: readonly TraceConfirmation[];
  unavailable?: boolean;
  active?: number | null;
  playing?: boolean;
  onPlay?: () => void;
  branch?: ReadonlySet<number>;
  editingStep?: number | null;
  onClearEditingStep?: () => void;
  onFocus?: (index: number) => void;
  onRealign?: (step: number, correction: string) => void;
  onConfirm?: (step: number) => void;
  onCheckSource?: (step: number) => void;
}

/** A spec can reference an existing offer or saved trace, never manufacture editor actions. */
export const WritingOfferContext = createContext<WritingOfferControls | null>(null);
export const TraceSurfaceContext = createContext<TraceSurface | null>(null);
export const TraceLookupContext = createContext<((offerId: string) => TraceSurface | null) | null>(null);
/** Puts a saved map back on the note it was drawn over. */
export const TraceReopenContext = createContext<((record: TraceRecord) => void) | null>(null);
/** Provided by AgentSpec so nested dynamic GenUI specs render without circular module imports. */
export const SpecRendererContext = createContext<((spec: Spec) => ReactNode) | null>(null);

export function surfaceFromRecord(record: TraceRecord): TraceSurface {
  return {
    id: record.offerId,
    offer: record.offer,
    provenance: record.provenance,
    anchored: record.anchored ?? record.provenance.map(source => !source),
    requested: record.requested,
    outcome: record.outcome,
    corrections: record.corrections,
    confirmed: record.confirmed,
  };
}

function surfaceFromControls(
  controls: WritingOfferControls,
  editingStep: number | null = null,
  onClearEditingStep?: () => void,
): TraceSurface {
  const { offer: prepared } = controls;
  const active = controls.map?.active ?? null;
  return {
    id: controls.id,
    offer: prepared.offer,
    provenance: prepared.provenance,
    resolved: prepared.resolved,
    confirmedSteps: prepared.confirmedSteps,
    anchored: prepared.trace.map(range => !!range),
    edited: prepared.edited,
    requested: prepared.requested,
    outcome: prepared.outcome ?? null,
    unavailable: controls.stale || controls.busy,
    active,
    playing: controls.map?.playing,
    onPlay: controls.map?.onPlay,
    branch: traceActivePath(prepared.offer.trace, active),
    editingStep,
    onClearEditingStep,
    onFocus: controls.map?.onFocus,
    onRealign: controls.map?.onRealign,
    onConfirm: controls.map?.onConfirm,
    onCheckSource: controls.map?.onCheckSource,
  };
}

function useResolvedTraceSurface(offerId: string | null | undefined): TraceSurface | null {
  const direct = useContext(TraceSurfaceContext);
  const controls = useContext(WritingOfferContext);
  const lookup = useContext(TraceLookupContext);
  if (direct && (!offerId || direct.id === offerId)) return direct;
  if (controls && !controls.stale && (!offerId || controls.id === offerId))
    return surfaceFromControls(controls);
  if (offerId && lookup) return lookup(offerId);
  return null;
}

const TITLES = {
  rewrite: "Let me show you a version",
  question: "Here's where I got lost",
  evidence: "I found something for this",
  move: "This belongs earlier",
};
const REVEAL_MS = 350;

function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** A brief visual reveal only. The full proposal can be accepted immediately. */
function useProposalReveal(text: string, editing: boolean) {
  const [visible, setVisible] = useState(text);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!text || editing || media?.matches) { setVisible(text); return; }
    const segments = typeof Intl.Segmenter === "function"
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment)
      : Array.from(text);
    let frame = 0;
    let start: number | undefined;
    const finish = () => { cancelAnimationFrame(frame); setVisible(text); };
    const tick = (now: number) => {
      start ??= now;
      const progress = Math.min(1, (now - start) / REVEAL_MS);
      setVisible(segments.slice(0, Math.ceil(segments.length * progress)).join(""));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    setVisible("");
    frame = requestAnimationFrame(tick);
    media?.addEventListener("change", finish);
    return () => { cancelAnimationFrame(frame); media?.removeEventListener("change", finish); };
  }, [text, editing]);
  return visible;
}

export const PROVENANCE: Record<ProvenanceEntry["kind"], string> = {
  you: "You said", chat: "Earlier discussion", web: "Web research", service: "Connected service",
  note: "Other notes", edit: "My edit", trace: "Earlier map",
};

function openSource(url: string) {
  void invoke("open_url_safe", { url }).catch((error) => toast.error(errorMessage(error)));
}

/**
 * A step that lives only in the conversation: an excerpt, not a note highlight,
 * with a way to see where it was said.
 */
export function OffPageStep({ entry, quote, expanded, onFocus, onExpand }: {
  entry: ProvenanceEntry | null | undefined;
  quote: string;
  expanded: boolean;
  onFocus?: () => void;
  onExpand: () => void;
}) {
  return <>
    <blockquote className="argument-map-steps-excerpt">{quote}</blockquote>
    <span className="argument-map-steps-links">
      <button type="button" onClick={() => {
        onFocus?.();
        if (!showTranscriptItem(entry?.itemId)) onExpand();
      }} aria-expanded={expanded}>{expanded ? "Hide source" : "Show in conversation"}</button>
    </span>
    {expanded && entry && <pre className="argument-map-steps-full" aria-label={`${PROVENANCE[entry.kind]} in full`}>{entry.text}</pre>}
  </>;
}

/** Renders a single trace step row (`li` in linear lists or `div` inside GenUI cards). */
export function TraceStepItem({ surface, index, as = "div" }: {
  surface: TraceSurface;
  index: number;
  as?: "li" | "div";
}) {
  const step = surface.offer.trace[index];
  const [correcting, setCorrecting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [earlierExpanded, setEarlierExpanded] = useState(false);
  const [correction, setCorrection] = useState("");
  const { editingStep, onClearEditingStep } = surface;
  useEffect(() => {
    if (editingStep !== index) return;
    setCorrecting(true);
    setCorrection("");
    onClearEditingStep?.();
  }, [editingStep, index, onClearEditingStep]);
  if (!step) return null;

  const entry = surface.provenance[index];
  const number = index + 1;
  const anchored = !!surface.anchored[index];
  const edited = !!surface.edited?.[index];
  // An earlier answer found by matching words: shown as a lead while the step is still an assumption.
  const earlier = step.sure ? null : surface.resolved?.[index] ?? null;
  const url = entry?.kind === "web" ? entry.urls?.map(safeSourceUrl).find(Boolean) : null;
  const savedCorrection = surface.corrections
    ? [...surface.corrections].reverse().find(item => item.step === index)
    : undefined;
  const isConfirmed = !!surface.confirmedSteps?.[index] || !!surface.confirmed?.some(item => item.step === index);
  const unavailable = !!surface.unavailable;
  const isActive = surface.active === index;
  const onBranch = !isActive && !!surface.branch?.has(index);
  const Tag = as;

  const submit = () => {
    if (unavailable || !correction.trim() || !surface.onRealign) return;
    surface.onRealign(index, correction.trim());
    setCorrecting(false);
    setCorrection("");
  };

  return <Tag className={as === "div" ? "argument-map-step-row" : undefined}
    data-trace-step={index}
    data-trace-live={surface.onFocus ? true : undefined}
    data-active={isActive || undefined}
    data-branch={onBranch || undefined}
    data-unsure={!step.sure || undefined}
    data-role={step.role === "tensions" ? "tensions" : undefined}
    data-source={entry?.kind}
    data-offpage={anchored ? undefined : true}>
    <span className="argument-map-steps-number" aria-hidden="true">{number}</span>
    <div className="argument-map-steps-body">
      {(entry || edited || step.role === "tensions") && <span className="argument-map-steps-source">
        {step.role === "tensions" && <span className="argument-map-steps-tension">Tension</span>}
        {step.role === "tensions" && (entry || edited) ? " · " : ""}
        {entry && <>
          <strong>{PROVENANCE[entry.kind]}</strong>
          {entry.label === "You said" || entry.label === "Earlier reply" ? "" : ` · ${entry.label.replace(/^Research: /, "")}`}
          {url && <a href={url} onClick={(event) => { event.preventDefault(); openSource(url); }}> ↗</a>}
        </>}
        {/* The quote below is what the agent read; the note has moved on from it. */}
        {edited && <strong>{anchored ? "You've changed this since" : "No longer in the note"}</strong>}
      </span>}
      {anchored ? (surface.onFocus
        ? <button type="button" className="argument-map-steps-quote" onClick={() => surface.onFocus?.(index)}
            aria-label={`Show step ${number} in the note`}>{step.quote}</button>
        : <span className="argument-map-steps-quote">{step.quote}</span>)
        : entry ? <OffPageStep entry={entry} quote={step.quote} expanded={expanded}
            onFocus={surface.onFocus ? () => surface.onFocus?.(index) : undefined}
            onExpand={() => setExpanded(value => !value)} />
        : <blockquote className="argument-map-steps-excerpt">{step.quote}</blockquote>}
      <p>
        {!step.sure && <span className="argument-map-steps-unsure">I assumed this · </span>}
        {step.sure && isConfirmed && <span className="argument-map-steps-confirmed">Confirmed · </span>}
        {step.reading}
      </p>
      {earlier && <>
        <span className="argument-map-steps-links">
          <span className="argument-map-steps-resolved">You may have answered this already</span>
          <button type="button" onClick={() => {
            if (!showTranscriptItem(earlier.itemId)) setEarlierExpanded(value => !value);
          }} aria-expanded={earlierExpanded}>{earlierExpanded ? "Hide earlier answer" : "Show earlier answer"}</button>
        </span>
        {earlierExpanded && <pre className="argument-map-steps-full" aria-label={`${earlier.label} in full`}>{earlier.text}</pre>}
      </>}
      {savedCorrection && <p className="agent-trace-record-correction"><strong>You meant:</strong> {savedCorrection.meant}</p>}
      {(surface.onConfirm || surface.onRealign || surface.onCheckSource) && (correcting ? <form className="argument-map-steps-correct" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea aria-label={`What you meant at step ${number}`} rows={2} maxLength={4000} autoFocus value={correction}
          placeholder="What did you mean here?" onChange={(event) => setCorrection(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); setCorrecting(false); }
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }} />
        <div className="writing-offer-actions">
          <button type="submit" className="agent-panel-primary" disabled={unavailable || !correction.trim()}>Re-think from here</button>
          <button type="button" onClick={() => setCorrecting(false)}>Cancel</button>
        </div>
      </form> : !step.sure ? <div className="argument-map-steps-actions" role="group" aria-label="Clarify assumption">
        {/* The assumption was about the words quoted above, which the note no longer has there. */}
        {surface.onConfirm && !edited && (
          <button type="button" className="argument-map-steps-confirm" disabled={unavailable}
            onClick={() => surface.onConfirm?.(index)}>Confirm assumption</button>
        )}
        {surface.onRealign && (
          <button type="button" className="argument-map-steps-realign" disabled={unavailable}
            onClick={() => { setCorrecting(true); setCorrection(""); }}>Correct it</button>
        )}
        {surface.onCheckSource && (
          <button type="button" className="argument-map-steps-source-check" disabled={unavailable}
            onClick={() => surface.onCheckSource?.(index)}>Check a source</button>
        )}
      </div> : surface.onRealign ? <div className="argument-map-steps-actions">
        <button type="button" className="argument-map-steps-realign" disabled={unavailable}
          onClick={() => { setCorrecting(true); setCorrection(""); }}>Not what I meant</button>
      </div> : null)}
    </div>
  </Tag>;
}

/** Renders the convergence outcome diamond row (`li` in linear lists or `div` inside GenUI specs). */
export function TraceOutcomeItem({ surface, as = "div" }: { surface: TraceSurface; as?: "li" | "div" }) {
  const { offer, outcome, requested } = surface;
  const outcomeIndex = offer.trace.length;
  const isActive = surface.active === outcomeIndex;
  const Tag = as;

  return <Tag className={as === "div" ? "argument-map-step-row" : undefined}
    data-decision data-trace-live={surface.onFocus ? true : undefined} data-active={isActive || undefined}>
    <span className="argument-map-steps-number" aria-hidden="true" />
    {outcome && surface.onFocus ? <div className="argument-map-steps-body">
      <span className="argument-map-steps-source">
        Your highlight · {outcome.paragraphs} {outcome.paragraphs === 1 ? "paragraph" : "paragraphs"}
      </span>
      <button type="button" className="argument-map-steps-quote argument-map-steps-outcome" onClick={() => surface.onFocus?.(outcomeIndex)}
        aria-label="Show your highlight in the note">{outcome.text}</button>
      <p><strong>What we learned:</strong> {offer.explanation}</p>
      <p><strong>My question is about:</strong></p>
      <button type="button" className="argument-map-steps-quote argument-map-steps-focus" onClick={() => surface.onFocus?.(outcomeIndex)}
        aria-label="Show the sentence my question is about">{offer.quote}</button>
      {offer.question && <p>{offer.question}</p>}
    </div> : surface.onFocus ? <div className="argument-map-steps-body">
      <button type="button" className="argument-map-steps-quote" onClick={() => surface.onFocus?.(outcomeIndex)}
        aria-label="Show where it led in the note">{offer.quote}</button>
      {requested === "outcome"
        ? <><p><strong>What we learned:</strong> {offer.explanation}</p>{offer.question && <p>{offer.question}</p>}</>
        : <p>So: {offer.kind === "question" ? offer.question : offer.explanation}</p>}
    </div> : <div className="argument-map-steps-body">
      <p><strong>What we learned:</strong> {offer.explanation}</p>
      {offer.question && <p>{offer.question}</p>}
    </div>}
  </Tag>;
}

/** GenUI catalog component: renders one verified trace step by 1-based index. */
export function TraceStepView({ offerId, step }: { offerId: string | null; step: number }) {
  const surface = useResolvedTraceSurface(offerId);
  if (!surface || !Number.isInteger(step) || step < 1 || step > surface.offer.trace.length)
    return <p className="text-xs text-text-muted">This trace step is no longer available.</p>;
  return <TraceStepItem surface={surface} index={step - 1} as="div" />;
}

/** GenUI catalog component: renders the convergence outcome diamond of an argument trace. */
export function TraceOutcomeView({ offerId }: { offerId: string | null }) {
  const surface = useResolvedTraceSurface(offerId);
  if (!surface)
    return <p className="text-xs text-text-muted">This trace outcome is no longer available.</p>;
  return <TraceOutcomeItem surface={surface} as="div" />;
}

/** How the agent got to this offer: linear steps or a dynamic GenUI convergent branch tree. */
function ArgumentMapSteps({ surface }: { surface: TraceSurface }) {
  const renderSpec = useContext(SpecRendererContext);
  const { offer } = surface;
  const convergent = isConvergentTrace(offer.trace) || !!offer.view;
  const segments = useMemo(() => traceBranches(offer.trace), [offer.trace]);
  const [selectedBranch, setSelectedBranch] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const { active, onFocus } = surface;
  // Up and down walk the map in the order it plays, taking the keyboard's place with them.
  const stepWithKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (!onFocus || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    if ((event.target as HTMLElement).closest("textarea, input, pre")) return;
    const order = tracePlaybackOrder(offer.trace);
    const at = active == null ? -1 : order.indexOf(active);
    const next = order[Math.max(0, Math.min(order.length - 1, at + (event.key === "ArrowDown" ? 1 : at < 0 ? 0 : -1)))];
    event.preventDefault();
    onFocus(next);
    const row = next === offer.trace.length ? "[data-decision]" : `[data-trace-step="${next}"]`;
    list.current?.querySelector<HTMLElement>(`${row} button`)?.focus({ preventScroll: true });
  };
  const playback = surface.onPlay && <div className="argument-map-steps-links">
    <button type="button" disabled={surface.unavailable} onClick={surface.onPlay}>
      {surface.playing ? "Pause" : "Play through"}</button>
    <span className="argument-map-steps-hint" aria-hidden="true">↑ ↓ to step</span>
  </div>;

  const activeBranchSteps = useMemo(() => {
    if (selectedBranch === null || !segments[selectedBranch]) return null;
    return traceActivePath(offer.trace, segments[selectedBranch].steps[0]);
  }, [selectedBranch, segments, offer.trace]);

  const spec = useMemo(() => {
    if (!convergent || !renderSpec) return null;
    return argumentMapSpec({
      offerId: surface.id,
      trace: offer.trace,
      provenance: surface.provenance,
      view: offer.view,
      activeBranchSteps,
    });
  }, [convergent, renderSpec, surface.id, offer.trace, offer.view, surface.provenance, activeBranchSteps]);

  if (spec && renderSpec) {
    return <TraceSurfaceContext.Provider value={surface}>
      <div ref={list} className="argument-map-genui" aria-label="How I got here" onKeyDown={stepWithKeys}>
        {playback}
        {segments.length > 1 && !offer.view && (
          <div className="argument-map-branch-bar" role="group" aria-label="Converging threads">
            <button type="button" className="agent-panel-chip" aria-pressed={selectedBranch === null}
              onClick={() => setSelectedBranch(null)}>
              All threads ({segments.length})
            </button>
            {segments.map((segment, idx) => {
              const firstStep = segment.steps[0];
              const src = surface.provenance[firstStep];
              const label = segment.synthesis
                ? "Synthesis"
                : segment.tensions
                  ? `Tension · #${firstStep + 1}`
                  : src
                    ? PROVENANCE[src.kind]
                    : `Branch ${idx + 1} · #${firstStep + 1}`;
              return <button key={idx} type="button" className="agent-panel-chip"
                data-tension={segment.tensions || undefined}
                aria-pressed={selectedBranch === idx}
                onClick={() => {
                  const next = selectedBranch === idx ? null : idx;
                  setSelectedBranch(next);
                  if (next !== null) surface.onFocus?.(firstStep);
                }}>
                {label}
              </button>;
            })}
          </div>
        )}
        {renderSpec(spec)}
      </div>
    </TraceSurfaceContext.Provider>;
  }

  return <div ref={list} className="argument-map-genui" onKeyDown={stepWithKeys}>
    {playback}
    <ol className="argument-map-steps" aria-label="How I got here">
      {offer.trace.map((step, index) => (
        <TraceStepItem key={`${index}:${step.quote}`} surface={surface} index={index} as="li" />
      ))}
      <TraceOutcomeItem surface={surface} as="li" />
    </ol>
  </div>;
}

function OfferView(controls: WritingOfferControls) {
  const { offer: prepared, stale, busy, onAccept, onAnswer, onShow, onDismiss, onAddToChat } = controls;
  const offer = prepared.offer;
  const [localDraft, setLocalDraft] = useState(offer.kind === "rewrite" ? offer.replacement ?? "" : "");
  const [editing, setEditing] = useState(false);
  const [editingStep, setEditingStep] = useState<number | null>(null);
  const draft = controls.draft ?? localDraft;
  const updateDraft = (value: string) => {
    setLocalDraft(value);
    controls.onDraftChange?.(value);
  };
  const revealed = useProposalReveal(offer.kind === "rewrite" ? draft : "", editing);
  const unavailable = stale || busy;
  const title = prepared.requested === "outcome" ? "How we got here"
    : prepared.requested === "readback" ? "What I took from this passage"
    : offer.alternative ? "Two ways to say it" : TITLES[offer.kind];
  const showLabel = offer.kind === "move" ? "Preview move" : "Show passage";
  const map = controls.map && offer.trace.length ? controls.map : null;
  const look = controls.onHighlight;
  const clearEditingStep = useMemo(() => () => setEditingStep(null), []);
  const surface = useMemo(
    () => surfaceFromControls(controls, editingStep, clearEditingStep),
    [controls, editingStep, clearEditingStep],
  );
  const unsureSteps = useMemo(
    () => offer.trace.flatMap((step, idx) => (!step.sure ? [{ step, idx }] : [])),
    [offer.trace],
  );
  // The quote is the way into the note: it takes you to the passage the card is about.
  const passage = <button type="button" className="writing-offer-passage" disabled={stale} onClick={onShow}
    aria-label="Show this passage in the note">
    <span className="writing-offer-passage-text">{offer.quote}</span>
    <span className="writing-offer-passage-hint" aria-hidden="true">Show in note</span>
  </button>;
  return <section className="writing-offer-card" data-kind={offer.kind} aria-label={title}
    onMouseEnter={() => look?.(true)} onMouseLeave={() => look?.(false)}
    onFocus={() => look?.(true)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) look?.(false); }}>
    <header><span className="writing-offer-kind">{offer.kind === "move" ? "Structure" : offer.kind === "rewrite" ? "A version to try" : offer.kind === "question" ? "One question" : "Source check"}</span>
      <h4>{title}</h4></header>
    <p className="writing-offer-explanation">{offer.explanation}</p>
    {offer.kind === "rewrite" && <>
      {offer.alternative && <div className="writing-offer-actions" aria-label="Compare versions">
        {[offer.replacement, offer.alternative].map((version, i) => <button key={i} type="button"
          aria-pressed={draft === version} onClick={() => { setEditing(false); updateDraft(version); }}>Version {i + 1}</button>)}
      </div>}
      <details className="writing-offer-original"><summary>Original passage</summary>{passage}</details>
      {editing ? <label className="writing-offer-field"><span>Your version</span>
        <textarea aria-label="Edit proposed wording" rows={4} maxLength={6000} value={draft}
          onChange={(event) => updateDraft(event.target.value)} />
      </label> : <div className="writing-offer-proposal" role="region" aria-label="Proposed wording" aria-live="off">
        {revealed}<span className="writing-offer-caret" aria-hidden="true" data-visible={revealed !== draft} />
      </div>}
      {prepared.previewContext && <details className="writing-offer-original"><summary>Read in context</summary>
        <p>{prepared.previewContext.before}<strong>{draft}</strong>{prepared.previewContext.after}</p>
        {prepared.previewContext.following && <p>{prepared.previewContext.following}</p>}
      </details>}
      <div className="writing-offer-actions">
        <button type="button" className="agent-panel-primary" disabled={unavailable || !draft.trim()}
          onClick={() => { if (!unavailable && draft.trim()) onAccept(draft); }}>Accept rewrite</button>
        {!editing && <button type="button" onClick={() => setEditing(true)}>Edit proposal</button>}
      </div>
    </>}
    {offer.kind === "question" && <form className="writing-offer-question" onSubmit={(event) => {
      event.preventDefault();
      if (!unavailable && draft.trim()) onAnswer(draft.trim());
    }}>
      {passage}
      {prepared.answered && <p className="agent-trace-record-correction"><strong>You answered:</strong> {prepared.answered}</p>}
      {!!offer.options?.length && <div className="writing-offer-options" role="group" aria-label="Suggested answers">
        {offer.options.map((option) => <button type="button" key={option} className="agent-panel-chip" disabled={unavailable}
          onClick={() => { if (!unavailable) onAnswer(option); }}>{option}</button>)}
      </div>}
      <label className="writing-offer-field"><span>{offer.question}</span>
        <textarea aria-label="Answer the writing question" rows={2} maxLength={4000} value={draft}
          placeholder="Think it through here…" onChange={(event) => updateDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter stays a newline for thinking aloud; ⌘Enter sends.
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }} />
      </label>
      <button type="submit" className="agent-panel-primary" disabled={unavailable || !draft.trim()}>Send answer</button>
    </form>}
    {offer.kind === "evidence" && <>
      {passage}
      <ul className="writing-offer-sources" aria-label="Sources for this passage">
        {offer.sources.slice(0, 3).map((source, index) => {
          const url = safeSourceUrl(source.url);
          return <li key={`${source.url}:${index}`}>
            {url ? <a href={url} onClick={(event) => { event.preventDefault(); openSource(url); }}>{source.title}<span aria-hidden="true"> ↗</span></a> : <span>{source.title}</span>}
            <p>{source.excerpt}</p>
          </li>;
        })}
      </ul>
    </>}
    {offer.kind === "move" && <>
      <div className="writing-offer-move" aria-label="Proposed paragraph order">
        <div className="writing-offer-ghost"><span>Move this paragraph</span><p>{offer.quote}</p></div>
        <span className="writing-offer-before">Before</span>
        <div className="writing-offer-destination"><p>{offer.destination}</p></div>
      </div>
      <button type="button" className="agent-panel-primary" disabled={unavailable}
        onClick={() => { if (!unavailable) onAccept(); }}>Apply move</button>
    </>}
    {map && !map.open && !stale && unsureSteps.length > 0 && (map.onConfirm || map.onCheckSource) && (
      <div className="writing-offer-assumption" role="region" aria-label="Unverified assumption">
        <p>
          <span className="argument-map-steps-unsure">I assumed this · </span>
          {unsureSteps[0].step.reading}
          {unsureSteps.length > 1 && <span className="writing-offer-assumption-more"> (+{unsureSteps.length - 1} more)</span>}
        </p>
        <div className="argument-map-steps-actions" role="group" aria-label="Clarify assumption">
          {map.onConfirm && !prepared.edited?.[unsureSteps[0].idx] && (
            <button type="button" className="argument-map-steps-confirm" disabled={unavailable}
              onClick={() => map.onConfirm?.(unsureSteps[0].idx)}>Confirm assumption</button>
          )}
          <button type="button" className="argument-map-steps-realign" disabled={unavailable}
            onClick={() => {
              setEditingStep(unsureSteps[0].idx);
              map.onToggle();
              map.onFocus(unsureSteps[0].idx);
            }}>Correct it</button>
          {map.onCheckSource && (
            <button type="button" className="argument-map-steps-source-check" disabled={unavailable}
              onClick={() => map.onCheckSource?.(unsureSteps[0].idx)}>Check a source</button>
          )}
        </div>
      </div>
    )}
    {map?.open && !stale && <ArgumentMapSteps surface={surface} />}
    {stale && <p className="writing-offer-stale" role="status">This passage changed. Review a fresh suggestion before applying it.</p>}
    <footer className="writing-offer-actions">
      {map && <button type="button" disabled={stale} aria-expanded={map.open} onClick={map.onToggle}>
        {map.open ? "Hide how I got here" : "How I got here"}</button>}
      <button type="button" disabled={stale} onClick={onShow}>{showLabel}</button>
      <button type="button" onClick={onAddToChat}>Add to chat</button>
      <button type="button" className="writing-offer-dismiss" onClick={onDismiss}>Dismiss</button>
    </footer>
  </section>;
}

export function WritingSuggestionView({ id }: { id: string }) {
  const controls = useContext(WritingOfferContext);
  if (!controls || controls.id !== id)
    return <p className="text-xs text-text-muted">This writing suggestion is no longer available.</p>;
  return <OfferView key={id} {...controls} />;
}
