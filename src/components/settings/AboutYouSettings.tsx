import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage, getProfile, setProfile, type WriterProfile } from "../../services/agent";

const FIELD =
  "block w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:border-accent";

const same = (a: WriterProfile, b: WriterProfile) => a.name === b.name && a.about === b.about;

/** Who the writer is, in their own words, sent with every agent request. */
export function AboutYouSettings() {
  const [saved, setSaved] = useState<WriterProfile | null>(null);
  // What's being typed; null while the fields show the saved profile.
  const [draft, setDraft] = useState<WriterProfile | null>(null);
  useEffect(() => {
    let active = true;
    getProfile().then(
      (profile) => { if (active) setSaved(profile); },
      (error) => toast.error(errorMessage(error)),
    );
    return () => { active = false; };
  }, []);
  const save = (profile: WriterProfile) =>
    setProfile(profile).catch((error) => {
      toast.error(errorMessage(error));
      return null;
    });
  const saveDraft = () => {
    if (!draft || !saved || same(draft, saved)) return;
    void save(draft).then((profile) => {
      if (!profile) return;
      setSaved(profile);
      setDraft((current) => (current && same(current, draft) ? null : current));
    });
  };
  // A tab shortcut or closing settings removes the fields without blurring
  // them, so what was typed is saved on the way out too.
  const unsaved = useRef<(() => void) | null>(null);
  unsaved.current = draft && saved && !same(draft, saved) ? () => { void save(draft); } : null;
  useEffect(() => () => unsaved.current?.(), []);
  const shown = draft ?? saved ?? { name: "", about: "" };
  const edit = (change: Partial<WriterProfile>) => setDraft({ ...shown, ...change });
  return (
    <div className="mt-4 rounded-[10px] border border-border p-4 space-y-3">
      <h3 className="text-sm font-medium">About you</h3>
      <div className="space-y-1.5">
        <label htmlFor="writer-name" className="block text-xs font-medium">Name</label>
        <input
          id="writer-name"
          type="text"
          maxLength={80}
          autoComplete="off"
          disabled={!saved}
          value={shown.name}
          onChange={(event) => edit({ name: event.target.value })}
          onBlur={saveDraft}
          className={FIELD}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="writer-about" className="block text-xs font-medium">What the agent should know</label>
        <textarea
          id="writer-about"
          rows={4}
          maxLength={2000}
          disabled={!saved}
          value={shown.about}
          onChange={(event) => edit({ about: event.target.value })}
          onBlur={saveDraft}
          placeholder="Your role, the people and projects in your notes, how you like things written."
          aria-describedby="writer-about-description"
          className={`${FIELD} resize-y leading-relaxed`}
        />
        <p id="writer-about-description" className="text-xs text-text-muted leading-relaxed">
          Sent with every request, in every notes folder, so the agent knows your name in a note means you.
          Saved on this Mac when you leave a field, and never synced with your notes.
        </p>
      </div>
    </div>
  );
}
