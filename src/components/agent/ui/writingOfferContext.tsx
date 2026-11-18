import { createContext, useContext, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { PreparedWritingOffer } from "../../../lib/agent/writingOffers";
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
  onDismiss: () => void;
  onAddToChat: () => void;
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
  const title = prepared.requested === "readback" ? "What I took from this passage"
    : offer.alternative ? "Two ways to say it" : TITLES[offer.kind];
  const showLabel = offer.kind === "question" ? "Trace argument" : offer.kind === "move" ? "Preview move" : "Show passage";
  return <section className="writing-offer-card" data-kind={offer.kind} aria-label={title}>
    <header><span className="writing-offer-kind">{offer.kind === "move" ? "Structure" : offer.kind === "rewrite" ? "A version to try" : offer.kind === "question" ? "One question" : "Source check"}</span>
      <h4>{title}</h4></header>
    <p className="writing-offer-explanation">{offer.explanation}</p>
    {offer.kind === "rewrite" && <>
      {offer.alternative && <div className="writing-offer-actions" aria-label="Compare versions">
        {[offer.replacement, offer.alternative].map((version, i) => <button key={i} type="button"
          aria-pressed={draft === version} onClick={() => { setEditing(false); updateDraft(version); }}>Version {i + 1}</button>)}
      </div>}
      <details className="writing-offer-original"><summary>Original passage</summary><blockquote>{offer.quote}</blockquote></details>
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
      <blockquote>{offer.quote}</blockquote>
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
      <blockquote>{offer.quote}</blockquote>
      <ul className="writing-offer-sources" aria-label="Sources for this passage">
        {offer.sources.slice(0, 3).map((source, index) => {
          const url = safeSourceUrl(source.url);
          return <li key={`${source.url}:${index}`}>
            {url ? <a href={url} onClick={(event) => {
              event.preventDefault();
              void invoke("open_url_safe", { url }).catch((error) => toast.error(errorMessage(error)));
            }}>{source.title}<span aria-hidden="true"> ↗</span></a> : <span>{source.title}</span>}
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
    {stale && <p className="writing-offer-stale" role="status">This passage changed. Review a fresh suggestion before applying it.</p>}
    <footer className="writing-offer-actions">
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
