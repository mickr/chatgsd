// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FoundSkills, RegistryListing, RegistrySkill, SkillOffer } from "../../services/agent";
import { AddSkill } from "./AddSkill";

const state = vi.hoisted(() => ({ skills: {} as Record<string, unknown> }));
vi.mock("../../context/SkillsContext", () => ({ useSkills: () => state.skills }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../services/agent", () => ({
  browseSkills: vi.fn(),
  findSkills: vi.fn(),
  readSkills: vi.fn(),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
const agent = vi.mocked(await import("../../services/agent"));
const dialog = vi.mocked(await import("@tauri-apps/plugin-dialog"));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
const install = vi.fn();

const entry = (name: string): RegistrySkill => ({
  name,
  source: "acme/skills",
  installs: 1200,
  official: false,
  url: `https://skills.sh/acme/skills/${name}`,
});
const listing = (...names: string[]): RegistryListing => ({ skills: names.map(entry), hasMore: false });
const offer = (name: string, from: Partial<SkillOffer>): SkillOffer => ({
  name,
  description: `The ${name} skill.`,
  source: null,
  content: `---\nname: ${name}\ndescription: The ${name} skill.\n---\n`,
  files: [],
  digest: `sha256:${name}`,
  archive: true,
  ...from,
});
const found = (...offers: SkillOffer[]): FoundSkills => ({ offers, skipped: [] });

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
const rows = () =>
  [...container.querySelectorAll("li > button[aria-expanded]")].map((row) => row.querySelector("span span")?.textContent);
/** Lets the debounce and whatever it started settle. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(400));
function type(text: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.skills = { skills: [], error: null, refresh: vi.fn(), install };
  agent.browseSkills.mockResolvedValue(listing("trip-planning", "rail"));
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

it("reads a skill chosen on skills.sh for review, and saves nothing until asked", async () => {
  agent.findSkills.mockResolvedValue(
    found(offer("rail", { source: "https://skills.sh/acme/skills/rail" })),
  );
  act(() => root.render(<AddSkill />));
  await settle();
  expect(agent.browseSkills).toHaveBeenCalledWith("", "all-time", 0);
  expect(rows()).toEqual(["trip-planning", "rail"]);
  expect(agent.findSkills).not.toHaveBeenCalled();

  act(() => container.querySelectorAll<HTMLButtonElement>("li > button[aria-expanded]")[1].click());
  await settle();
  expect(agent.findSkills).toHaveBeenCalledWith("https://skills.sh/acme/skills/rail");
  expect(container.textContent).toContain("The rail skill.");
  expect(install).not.toHaveBeenCalled();
  await act(async () => button("Save skill")!.click());
  expect(install).toHaveBeenCalledWith(expect.objectContaining({ name: "rail", digest: "sha256:rail" }));
});

it("shows the latest search even when an earlier one answers after it", async () => {
  act(() => root.render(<AddSkill />));
  await settle();
  let answerFirst!: (value: RegistryListing) => void;
  agent.browseSkills.mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)));
  type("tr");
  await settle();
  agent.browseSkills.mockResolvedValueOnce(listing("trip-planning"));
  type("trip");
  await settle();
  expect(agent.browseSkills).toHaveBeenLastCalledWith("trip", "all-time", 0);
  await act(async () => answerFirst(listing("transit", "trains")));
  expect(rows()).toEqual(["trip-planning"]);
  // One character isn't a search: the leaderboard stays, without a second request for it.
  agent.browseSkills.mockClear();
  type("");
  await settle();
  type("t");
  await settle();
  expect(agent.browseSkills).toHaveBeenCalledTimes(1);
  expect(agent.browseSkills).toHaveBeenCalledWith("", "all-time", 0);
});

it("says so when skills.sh can't be reached, and tries again", async () => {
  agent.browseSkills.mockRejectedValueOnce("Couldn't reach skills.sh");
  act(() => root.render(<AddSkill />));
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't reach skills.sh");
  act(() => button("Try again")!.click());
  await settle();
  expect(rows()).toEqual(["trip-planning", "rail"]);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("reads everything chosen on this Mac, and names what couldn't be read beside what could", async () => {
  dialog.open.mockResolvedValue(["/Users/sam/skills/pack", "/Users/sam/notes.md"]);
  agent.readSkills.mockImplementation((path) =>
    path.endsWith("pack")
      ? Promise.resolve({
          offers: [offer("rail", { path }), offer("ferry", { path })],
          skipped: ["twin: Another skill here is also named rail"],
        })
      : Promise.reject("A skill starts with YAML frontmatter between --- lines"),
  );
  act(() => root.render(<AddSkill />));
  await settle();
  act(() => button("This Mac")!.click());
  await act(async () => button("Choose a folder…")!.click());
  await settle();
  expect(dialog.open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
  const cards = [...container.querySelectorAll(".agent-skill-offer h3")].map((item) => item.textContent);
  expect(cards).toEqual(["rail", "ferry"]);
  const leftOut = [...container.querySelectorAll('[role="status"] li')].map((item) => item.textContent);
  expect(leftOut).toEqual([
    "twin: Another skill here is also named rail",
    "/Users/sam/notes.md: A skill starts with YAML frontmatter between --- lines",
  ]);
  // The path goes back with the offer: saving reads the skill's files from it again.
  await act(async () => button("Save skill")!.click());
  expect(install).toHaveBeenCalledWith(expect.objectContaining({ name: "rail", path: "/Users/sam/skills/pack" }));
});

it("keeps what was already found when the file dialog is cancelled", async () => {
  dialog.open.mockResolvedValueOnce("/Users/sam/rail.skill").mockResolvedValueOnce(null);
  agent.readSkills.mockResolvedValue(found(offer("rail", { path: "/Users/sam/rail.skill" })));
  act(() => root.render(<AddSkill />));
  await settle();
  await act(async () => button("Choose a file…")!.click());
  await settle();
  expect(container.querySelectorAll(".agent-skill-offer")).toHaveLength(1);
  await act(async () => button("Choose a file…")!.click());
  await settle();
  expect(agent.readSkills).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll(".agent-skill-offer")).toHaveLength(1);
});
