import type { Skill } from "../../services/agent";

/** Where the leading `/command` of a draft ends: its first whitespace, or the end. */
const commandEnd = (text: string) => {
  const space = text.search(/\s/);
  return space < 0 ? text.length : space;
};

/**
 * The enabled skill a message invokes by starting with `/name`. Anything else
 * that starts with a slash (a path, a typo, a turned-off skill) is ordinary text.
 */
export function invokedSkill(text: string, skills: readonly Skill[] | null): string | null {
  if (!skills || !text.startsWith("/")) return null;
  const name = text.slice(1, commandEnd(text));
  return skills.find((skill) => skill.enabled && skill.name === name)?.name ?? null;
}

/**
 * What the writer is typing after `/` while the caret is still in the leading
 * command, or null when the menu has nothing to complete.
 */
export function skillQuery(text: string, caret: number): string | null {
  if (!text.startsWith("/")) return null;
  const end = commandEnd(text);
  return caret >= 1 && caret <= end ? text.slice(1, end) : null;
}

/** Enabled skills for a query: names starting with it, then names or descriptions containing it. */
export function matchSkills(skills: readonly Skill[], query: string): Skill[] {
  const needle = query.toLowerCase();
  const enabled = skills.filter((skill) => skill.enabled);
  if (!needle) return enabled;
  const starts = enabled.filter((skill) => skill.name.startsWith(needle));
  const contains = enabled.filter((skill) => !skill.name.startsWith(needle) &&
    (skill.name.includes(needle) || skill.description.toLowerCase().includes(needle)));
  return [...starts, ...contains];
}

/** The draft with its leading command replaced by `/name `, and the caret just after it. */
export function completeSkill(text: string, name: string): { text: string; caret: number } {
  const rest = text.slice(commandEnd(text)).replace(/^[ \t]+/, "");
  const command = `/${name} `;
  return { text: command + rest, caret: command.length };
}
