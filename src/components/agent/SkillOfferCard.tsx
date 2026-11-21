import { memo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useSkills } from "../../context/SkillsContext";
import { errorMessage, type SkillOffer } from "../../services/agent";
import { CheckIcon, SkillIcon, SpinnerIcon } from "../icons";

/** "docs.example.com" for a source address, or the address itself if it won't parse. */
export function sourceHost(source: string) {
  try {
    return new URL(source).host;
  } catch {
    return source;
  }
}

/** "trip.skill" for a path on this Mac. */
function fileName(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** The address a skill came from, opened in the browser on click. */
export function SkillSource({ source }: { source: string }) {
  return (
    <button
      type="button"
      className="agent-panel-link agent-panel-link-quiet truncate"
      title={source}
      onClick={() => {
        void invoke("open_url_safe", { url: source }).catch((error) =>
          toast.error(errorMessage(error)),
        );
      }}
    >
      {sourceHost(source)}
    </button>
  );
}

/** A skill's whole SKILL.md behind a disclosure, so it can be read before it's trusted. */
export function SkillInstructions({ content }: { content: string }) {
  return (
    <details className="agent-skill-instructions">
      <summary>Read the instructions</summary>
      <pre tabIndex={0}>{content}</pre>
    </details>
  );
}

/**
 * A skill found on the web or on this Mac, for the user to review and save.
 * Nothing is installed until they press Save, and what's saved is the content
 * shown here.
 */
export const SkillOfferCard = memo(function SkillOfferCard({
  offer,
  dismissed = false,
  onDismiss,
}: {
  offer: SkillOffer;
  dismissed?: boolean;
  onDismiss?: () => void;
}) {
  const { skills, error: loadError, refresh, install } = useSkills();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const installed = skills?.find((skill) => skill.name === offer.name);
  // The same instructions and files; matching instructions alone could be a
  // standalone copy of a skill that brings more.
  const saved = installed
    ? installed.digest
      ? installed.digest === offer.digest
      : !offer.archive && installed.content === offer.content
    : false;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await install(offer);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };
  if (dismissed && !saved && !reviewing)
    return (
      <p className="flex items-center gap-1.5 text-xs text-text-muted">
        <SkillIcon className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">Skill not saved: {offer.name}</span>
        <button
          type="button"
          className="agent-panel-link agent-panel-link-quiet shrink-0"
          onClick={() => setReviewing(true)}
        >
          Review
        </button>
      </p>
    );
  return (
    <section
      className="agent-skill-offer"
      data-saved={saved || undefined}
      aria-label={`Skill offered: ${offer.name}`}
    >
      <header className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted">
        <SkillIcon className="w-3.5 h-3.5 shrink-0" />
        <span>{saved ? "Skill saved" : installed ? "Skill update" : "Skill offered"}</span>
        <span className="ml-auto min-w-0 truncate normal-case tracking-normal">
          {offer.source ? (
            <SkillSource source={offer.source} />
          ) : (
            offer.path && <span title={offer.path}>{fileName(offer.path)}</span>
          )}
        </span>
      </header>
      <div className="space-y-1">
        <h3 className="font-mono text-xs font-medium">{offer.name}</h3>
        <p className="text-xs leading-relaxed text-text-muted">{offer.description}</p>
      </div>
      <SkillInstructions content={offer.content} />
      {offer.files.length > 0 && (
        <p className="text-[11px] leading-relaxed text-text-muted">
          Comes with {offer.files.length} {offer.files.length === 1 ? "file" : "files"} for the agent to
          read, such as {offer.files[0]}. Nothing in a skill is run.
        </p>
      )}
      {saved ? (
        <p className="flex items-center gap-1.5 text-xs text-text-muted" role="status">
          <CheckIcon className="w-3.5 h-3.5 shrink-0 text-accent" />
          The agent can use it from your next message.
          {onDismiss && " Manage skills in Settings."}
        </p>
      ) : (
        <>
          <p className="text-[11px] leading-relaxed text-text-muted">
            {installed
              ? "This differs from the version you have saved. Updating replaces it."
              : "A skill is instructions the agent follows in every note. Save it only if you trust the source."}
          </p>
          {error && (
            <p role="alert" className="text-xs text-red-500">
              {error}
            </p>
          )}
          {skills === null && loadError && (
            <p role="alert" className="text-xs text-red-500">
              Couldn't load your skills: {loadError}{" "}
              <button type="button" className="agent-panel-link" onClick={() => void refresh()}>
                Try again
              </button>
            </p>
          )}
          <div className="flex items-center justify-end gap-3">
            {onDismiss && !dismissed && (
              <button
                type="button"
                className="agent-panel-link agent-panel-link-quiet"
                disabled={saving}
                onClick={onDismiss}
              >
                Not now
              </button>
            )}
            <button
              type="button"
              className="agent-panel-primary gap-1.5"
              disabled={saving || skills === null}
              onClick={() => void save()}
            >
              {saving && <SpinnerIcon className="w-3 h-3 animate-spin" />}
              {installed ? "Update skill" : "Save skill"}
            </button>
          </div>
        </>
      )}
    </section>
  );
});
