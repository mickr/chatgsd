import { createContext, useContext, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { PreparedWritingOffer } from "../../../lib/agent/writingOffers";
import type { ProvenanceEntry } from "../../../lib/agent/provenance";
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
  /** The map of how the agent got here: open or not, the step being read, and a way to correct one. */
  map?: { open: boolean; active: number | null; onToggle: () => void; onFocus: (index: number) => void;
    onRealign: (step: number, correction: string) => void };
}

/** A spec can reference an existing offer, but cannot manufacture editor actions. */
export const WritingOfferContext = createContext<WritingOfferControls | null>(null);

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

/** Each step's number among the steps anchored in the note, or null for one that isn't. */
export function stepNumbers(anchored: readonly boolean[]): (number | null)[] {
  let count = 0;
  return anchored.map(inNote => (inNote ? ++count : null));
}

export const PROVENANCE: Record<ProvenanceEntry["kind"], string> = {
  you: "You said", web: "Web research", service: "Connected service", note: "Other notes", edit: "My edit", trace: "Earlier map",
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

/** How the agent got to this offer, step by step, with a way to say where it misread. */
function ArgumentMapSteps({ prepared, map, unavailable }: {
  prepared: PreparedWritingOffer;
  map: NonNullable<WritingOfferControls["map"]>;
  unavailable: boolean;
}) {
  const { offer } = prepared;
  // Numbers count the passages you can see in the note; a step only in the conversation gets a hollow marker.
  const numbers = stepNumbers(prepared.trace.map(range => !!range));
  const [correcting, setCorrecting] = useState<number | null>(null);
  // A step whose source isn't in the conversation on screen shows it here instead.
  const [expanded, setExpanded] = useState<number | null>(null);
  const [correction, setCorrection] = useState("");
  const submit = (step: number) => {
    if (unavailable || !correction.trim()) return;
    map.onRealign(step, correction.trim());
    setCorrecting(null);
    setCorrection("");
  };
  return <ol className="argument-map-steps" aria-label="How I got here">
    {offer.trace.map((step, index) => {
      const entry = prepared.provenance[index];
      const url = entry?.kind === "web" ? entry.urls?.map(safeSourceUrl).find(Boolean) : null;
      return <li key={`${index}:${step.quote}`} data-active={map.active === index || undefined}
      data-unsure={!step.sure || undefined} data-source={entry?.kind} data-offpage={numbers[index] ? undefined : true}>
      <span className="argument-map-steps-number" aria-hidden="true">{numbers[index] ?? ""}</span>
      <div className="argument-map-steps-body">
        {entry && <span className="argument-map-steps-source">
          <strong>{PROVENANCE[entry.kind]}</strong>{entry.kind === "you" ? "" : ` · ${entry.label.replace(/^Research: /, "")}`}
          {url && <a href={url} onClick={(event) => { event.preventDefault(); openSource(url); }}> ↗</a>}
        </span>}
        {numbers[index] ? <button type="button" className="argument-map-steps-quote" onClick={() => map.onFocus(index)}
          aria-label={`Show step ${numbers[index]} in the note`}>{step.quote}</button>
          : <OffPageStep entry={entry} quote={step.quote} expanded={expanded === index} onFocus={() => map.onFocus(index)}
            onExpand={() => setExpanded(expanded === index ? null : index)} />}
        <p>{!step.sure && <span className="argument-map-steps-unsure">I assumed this · </span>}{step.reading}</p>
        {correcting === index ? <form className="argument-map-steps-correct" onSubmit={(event) => { event.preventDefault(); submit(index); }}>
          <textarea aria-label={`What you meant at step ${index + 1}`} rows={2} maxLength={4000} autoFocus value={correction}
            placeholder="What did you mean here?" onChange={(event) => setCorrection(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); setCorrecting(null); }
              if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit(index);
            }} />
          <div className="writing-offer-actions">
            <button type="submit" className="agent-panel-primary" disabled={unavailable || !correction.trim()}>Re-think from here</button>
            <button type="button" onClick={() => setCorrecting(null)}>Cancel</button>
          </div>
        </form> : <button type="button" className="argument-map-steps-realign" disabled={unavailable}
          onClick={() => { setCorrecting(index); setCorrection(""); }}>Not what I meant</button>}
      </div>
    </li>;
    })}
    <li data-decision data-active={map.active === offer.trace.length || undefined}>
      <span className="argument-map-steps-number" aria-hidden="true" />
      {prepared.outcome ? <div className="argument-map-steps-body">
        <span className="argument-map-steps-source">
          Your highlight · {prepared.outcome.paragraphs} {prepared.outcome.paragraphs === 1 ? "paragraph" : "paragraphs"}
        </span>
        <button type="button" className="argument-map-steps-quote argument-map-steps-outcome" onClick={() => map.onFocus(offer.trace.length)}
          aria-label="Show your highlight in the note">{prepared.outcome.text}</button>
        <p><strong>What we learned:</strong> {offer.explanation}</p>
        <p><strong>My question is about:</strong></p>
        <button type="button" className="argument-map-steps-quote argument-map-steps-focus" onClick={() => map.onFocus(offer.trace.length)}
          aria-label="Show the sentence my question is about">{offer.quote}</button>
        {offer.question && <p>{offer.question}</p>}
      </div> : <div className="argument-map-steps-body">
        <button type="button" className="argument-map-steps-quote" onClick={() => map.onFocus(offer.trace.length)}
          aria-label="Show where it led in the note">{offer.quote}</button>
        {prepared.requested === "outcome"
          ? <><p><strong>What we learned:</strong> {offer.explanation}</p>{offer.question && <p>{offer.question}</p>}</>
          : <p>So: {offer.kind === "question" ? offer.question : offer.explanation}</p>}
      </div>}
    </li>
  </ol>;
}

function OfferView(controls: WritingOfferControls) {
  const { offer: prepared, stale, busy, onAccept, onAnswer, onShow, onDismiss, onAddToChat } = controls;
  const offer = prepared.offer;
  const [localDraft, setLocalDraft] = useState(offer.kind === "rewrite" ? offer.replacement ?? "" : "");
  const [editing, setEditing] = useState(false);
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
    {map?.open && !stale && <ArgumentMapSteps prepared={prepared} map={map} unavailable={unavailable} />}
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
