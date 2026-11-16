// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Skill, SkillOffer } from "../../services/agent";
import { SkillOfferCard } from "./SkillOfferCard";

const state = vi.hoisted(() => ({ skills: {} as Record<string, unknown> }));
vi.mock("../../context/SkillsContext", () => ({ useSkills: () => state.skills }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;

const content = "---\nname: trip-planning\ndescription: Plan trips.\n---\n\n# Trip planning\n";
const archive: SkillOffer = {
  name: "trip-planning",
  description: "Plan trips.",
  source: "https://docs.example.com/trip-planning.tar.gz",
  content,
  files: ["references/rail.md"],
  digest: `sha256:${"a".repeat(64)}`,
  archive: true,
};
const installed = (digest: string | null): Skill => ({
  name: "trip-planning", description: "Plan trips.", source: null, installedAt: 0,
  enabled: true, content, files: [], digest,
});
const render = (offer: SkillOffer) => act(() => root.render(<SkillOfferCard offer={offer} />));
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);

beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  state.skills = { skills: [], error: null, refresh: vi.fn(), install: vi.fn() };
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

it("offers an archive as an update when only the same instructions are saved without its files", () => {
  state.skills.skills = [installed(`sha256:${"b".repeat(64)}`)];
  render(archive);
  expect(button("Update skill")).toBeTruthy();
  expect(container.textContent).not.toContain("Skill saved");

  state.skills = { ...state.skills, skills: [installed(null)] };
  render({ ...archive });
  expect(button("Update skill")).toBeTruthy();

  state.skills = { ...state.skills, skills: [installed(archive.digest)] };
  render({ ...archive });
  expect(button("Update skill")).toBeUndefined();
  expect(container.textContent).toContain("Skill saved");
});

it("says why saving is unavailable when the skills couldn't be loaded, and retries", () => {
  const refresh = vi.fn();
  state.skills = { skills: null, error: "disk unavailable", refresh, install: vi.fn() };
  render(archive);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("disk unavailable");
  expect(button("Save skill")?.disabled).toBe(true);
  act(() => button("Try again")!.click());
  expect(refresh).toHaveBeenCalledTimes(1);
});
