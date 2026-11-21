import { memo, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui";
import { SkillIcon, SpinnerIcon } from "../icons";
import { useSkills } from "../../context/SkillsContext";
import { errorMessage, type Skill } from "../../services/agent";
import { SkillInstructions, SkillSource } from "../agent/SkillOfferCard";
import { AddSkill } from "./AddSkill";
import { formatDate } from "../../lib/utils";

const SkillRow = memo(function SkillRow({
  skill,
  onRemove,
}: {
  skill: Skill;
  onRemove: (skill: Skill) => void;
}) {
  const { setEnabled } = useSkills();
  const descriptionId = `skill-${skill.name}-description`;
  return (
    <li className="rounded-[10px] border border-border p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h3 className="font-mono text-sm font-medium">{skill.name}</h3>
          <p
            id={descriptionId}
            className={`text-sm leading-relaxed ${skill.enabled ? "text-text-muted" : "text-text-muted/60"}`}
          >
            {skill.description}
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
          {skill.enabled ? "On" : "Off"}
          <input
            type="checkbox"
            checked={skill.enabled}
            aria-label={`Use the skill ${skill.name}`}
            aria-describedby={descriptionId}
            onChange={(event) => {
              void setEnabled(skill.name, event.target.checked).catch((error) =>
                toast.error(`Couldn't change the skill: ${errorMessage(error)}`),
              );
            }}
          />
        </label>
      </div>
      <SkillInstructions content={skill.content} />
      <div className="flex items-center justify-between gap-3 text-xs text-text-muted">
        <span className="flex min-w-0 items-center gap-1.5">
          {skill.source ? (
            <>
              <span className="shrink-0">From</span>
              <SkillSource source={skill.source} />
            </>
          ) : (
            "Added from this Mac"
          )}
          {skill.installedAt > 0 && (
            <span className="shrink-0">· Saved {formatDate(skill.installedAt / 1000)}</span>
          )}
          {skill.files.length > 0 && (
            <span className="shrink-0" title={skill.files.join("\n")}>
              · {skill.files.length} {skill.files.length === 1 ? "file" : "files"}
            </span>
          )}
        </span>
        <button
          type="button"
          className="shrink-0 hover:text-text"
          onClick={() => onRemove(skill)}
        >
          Remove
        </button>
      </div>
    </li>
  );
});

export function SkillsSettingsSection() {
  const { skills, error, refresh, remove } = useSkills();
  const [removing, setRemoving] = useState<Skill | null>(null);
  const confirmRemove = () => {
    if (!removing) return;
    const { name } = removing;
    setRemoving(null);
    void remove(name).catch((reason) =>
      toast.error(`Couldn't remove the skill: ${errorMessage(reason)}`),
    );
  };
  const active = skills?.filter((skill) => skill.enabled).length ?? 0;
  return (
    <div className="space-y-8 py-8">
      <section className="pb-2">
        <h2 className="text-xl font-medium mb-0.5">Skills</h2>
        <p className="text-sm text-text-muted mb-4">
          Instructions you've saved for the agent. It sees each skill's name and description, and
          reads the full instructions when a request calls for them. Skills apply in every notes folder.
        </p>
        {error && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-red-500/20 bg-red-500/10 p-3">
            <p role="alert" className="text-sm text-red-500">{error}</p>
            <button type="button" className="shrink-0 text-xs text-text-muted hover:text-text" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}
        {skills === null && !error && (
          <div className="flex items-center gap-2 p-3 text-sm text-text-muted">
            <SpinnerIcon className="w-4 h-4 animate-spin" />
            Loading your skills…
          </div>
        )}
        {skills?.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border border-dashed px-6 py-8 text-center">
            <SkillIcon className="w-6 h-6 text-text-muted/50" />
            <h3 className="text-sm font-medium">No skills installed</h3>
            <p className="max-w-md text-sm leading-relaxed text-text-muted">
              When the agent's research turns up a site that publishes a skill for what you're working on,
              it offers the skill in the panel and you choose whether to save it. You can also add one below,
              from skills.sh, this Mac or a web address.
            </p>
          </div>
        )}
        {skills && skills.length > 0 && (
          <>
            <p className="mb-2.5 text-xs text-text-muted" role="status">
              {skills.length} installed · {active} on
            </p>
            <ul className="space-y-2.5">
              {skills.map((skill) => (
                <SkillRow key={skill.name} skill={skill} onRemove={setRemoving} />
              ))}
            </ul>
          </>
        )}
      </section>

      <div className="border-t border-border border-dashed" />

      <section className="pb-2">
        <h2 className="text-xl font-medium mb-0.5">Add a skill</h2>
        <p className="text-sm text-text-muted mb-4">
          You'll see each skill's instructions before anything is saved, and nothing in a skill is run.
        </p>
        <AddSkill />
      </section>

      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this skill?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent will stop using {removing?.name}.
              {removing?.source ? " You can add it again from its address." : " It was added from this Mac, so keep a copy if you want it back."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
