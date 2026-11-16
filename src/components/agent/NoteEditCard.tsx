import { memo, useContext, useMemo, useState } from "react";
import type { NoteEditItem, NoteEditPreview } from "../../context/AgentContext";
import { inlineDiff } from "../../lib/agent/inlineDiff";
import { CheckIcon, NoteIcon, SpinnerIcon } from "../icons";
import { OpenNoteContext } from "./ui/registry";

/** Longer sides of an edit are clipped until the user asks to see them whole. */
const CLIP_CHARS = 1200;

function Clipped({ text, as: Tag }: { text: string; as: "del" | "ins" }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const clip = !open && text.length > CLIP_CHARS;
  return (
    <>
      <Tag>{clip ? text.slice(0, CLIP_CHARS) : text}</Tag>
      {clip && (
        <button
          type="button"
          className="agent-edit-more"
          onClick={() => setOpen(true)}
        >
          Show all {text.length.toLocaleString()} characters
        </button>
      )}
    </>
  );
}

function Hunk({ hunk }: { hunk: NoteEditPreview }) {
  const diff = useMemo(
    () => inlineDiff(hunk.removed, hunk.added),
    [hunk.removed, hunk.added],
  );
  return (
    <p className="agent-edit-hunk">
      <span className="agent-edit-context">{hunk.before}</span>
      {diff.prefix}
      <Clipped as="del" text={diff.removed} />
      <Clipped as="ins" text={diff.added} />
      {diff.suffix}
      <span className="agent-edit-context">{hunk.after}</span>
    </p>
  );
}

export const NoteEditCard = memo(function NoteEditCard({
  item,
  active,
  onApprove,
  onDecline,
}: {
  item: NoteEditItem;
  /** The run is waiting on this proposal. */
  active: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const openNote = useContext(OpenNoteContext);
  const count = item.edits.length;
  return (
    <section
      className="agent-ui-card agent-edit"
      data-active={active || undefined}
      aria-label={`Proposed edit to ${item.title}`}
    >
      <header className="agent-edit-header">
        <NoteIcon className="w-3.5 h-3.5 shrink-0 text-text-muted" />
        <button
          type="button"
          className="agent-edit-title"
          onClick={() => openNote(item.noteId)}
          title={`Open ${item.title}`}
        >
          {item.title}
        </button>
        <span className="agent-edit-count">
          {count} {count === 1 ? "change" : "changes"}
        </span>
      </header>
      {item.summary && <p className="agent-edit-summary">{item.summary}</p>}
      <div className="agent-edit-preview">
        {item.preview.map((hunk, index) => (
          <Hunk key={index} hunk={hunk} />
        ))}
      </div>
      <footer className="agent-edit-footer">
        {item.status === "pending" && active && (
          <>
            <button
              type="button"
              className="agent-panel-primary"
              onClick={onApprove}
            >
              Approve edit
            </button>
            <button
              type="button"
              className="agent-panel-link agent-panel-link-quiet"
              onClick={onDecline}
            >
              Decline
            </button>
            <span className="agent-edit-hint">
              Or say what to change instead below.
            </span>
          </>
        )}
        {item.status === "pending" && !active && (
          <span className="agent-edit-status">Not applied.</span>
        )}
        {item.status === "applying" && (
          <span className="agent-edit-status">
            <SpinnerIcon className="w-3.5 h-3.5 animate-spin" />
            Saving…
          </span>
        )}
        {item.status === "applied" && (
          <span className="agent-edit-status" data-tone="success">
            <CheckIcon className="w-3.5 h-3.5" />
            Saved to {item.title}
          </span>
        )}
        {item.status === "declined" && (
          <span className="agent-edit-status">
            Declined{item.message ? `: “${item.message}”` : "."}
          </span>
        )}
        {item.status === "failed" && (
          <span className="agent-edit-status" data-tone="error">
            Couldn't save: {item.message}
          </span>
        )}
      </footer>
    </section>
  );
});
