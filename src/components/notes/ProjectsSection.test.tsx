// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ProjectsService from "../../services/projects";
import type { Project } from "../../services/projects";
import { TooltipProvider } from "../ui";
import { ProjectsSection } from "./ProjectsSection";

const state = vi.hoisted(() => ({
  projects: [] as unknown[],
  changed: null as ((projects: unknown[]) => void) | null,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(["/Users/sam/code/app/docs", "/Volumes/Work/specs"])),
}));
vi.mock("../../services/projects", async (original) => ({
  ...(await original<typeof ProjectsService>()),
  listProjects: vi.fn(() => Promise.resolve(state.projects)),
  onProjectsChanged: vi.fn((handler: (projects: unknown[]) => void) => {
    state.changed = handler;
    return Promise.resolve(() => {});
  }),
  createProject: vi.fn(() => Promise.resolve()),
  addFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  folderFiles: vi.fn(() =>
    Promise.resolve([
      { id: "guides/setup/install", modified: 1_700_000_000 },
      { id: "guides/style", modified: 1_600_000_000 },
      { id: "readme", modified: 1_650_000_000 },
    ]),
  ),
  openFile: vi.fn(() => Promise.resolve()),
}));
const projects = await import("../../services/projects");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;

const handbook: Project = {
  id: "p1",
  name: "Client Work",
  folders: [
    { label: "handbook", path: "/Users/sam/code/app/handbook", missing: false },
    { label: "archive", path: "/Volumes/Old/archive", missing: true },
  ],
};

async function render(list: Project[]) {
  state.projects = list;
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ProjectsSection />
      </TooltipProvider>,
    ),
  );
}
const row = (text: string) =>
  [...container.querySelectorAll<HTMLElement>('[role="button"]')].find((entry) =>
    entry.textContent?.includes(text),
  )!;
const click = (element: HTMLElement) => act(async () => element.click());

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

it("explains projects when there are none", async () => {
  await render([]);
  expect(container.textContent).toContain("Link folders from anywhere on your Mac");
});

it("shows each linked folder's place, file count and last change without opening it", async () => {
  await render([handbook]);

  const folder = row("handbook");
  expect(folder.textContent).toContain("3");
  expect(folder.textContent).toContain("~/code/app/handbook");
  expect(folder.textContent).toMatch(/Changed .*2023/);
  expect(folder.title).toBe("/Users/sam/code/app/handbook");
  expect(container.textContent).not.toContain("readme");

  expect(row("archive").textContent).toContain("Not found · /Volumes/Old/archive");
  expect(projects.folderFiles).toHaveBeenCalledTimes(1);
  expect(projects.folderFiles).toHaveBeenCalledWith("p1", "handbook");
});

it("opens a linked folder into its tree and opens a file by its project ID", async () => {
  await render([handbook]);

  await click(row("handbook"));
  expect(projects.folderFiles).toHaveBeenCalledTimes(2);
  expect(row("readme")).toBeTruthy();
  expect(container.textContent).not.toContain("style");

  await click(row("guides"));
  await click(row("style"));
  expect(projects.openFile).toHaveBeenCalledWith("project:Client Work/handbook/guides/style");

  await click(row("setup"));
  await click(row("install"));
  expect(projects.openFile).toHaveBeenLastCalledWith(
    "project:Client Work/handbook/guides/setup/install",
  );
});

it("adds every folder picked, and follows changes the backend announces", async () => {
  await render([{ id: "p2", name: "Research", folders: [] }]);

  await click(
    [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Add folders…")!,
  );
  expect(projects.addFolder).toHaveBeenNthCalledWith(1, "p2", "/Users/sam/code/app/docs");
  expect(projects.addFolder).toHaveBeenNthCalledWith(2, "p2", "/Volumes/Work/specs");

  await act(async () => state.changed!([handbook]));
  expect(row("Client Work")).toBeTruthy();
  expect(container.textContent).not.toContain("Research");
});

it("creates a project from the name dialog", async () => {
  await render([]);

  await click(container.querySelector<HTMLElement>('[aria-label="New Project"]')!);
  const input = document.body.querySelector<HTMLInputElement>('input[placeholder="Project name"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Research");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

  expect(projects.createProject).toHaveBeenCalledWith("Research");
});

describe("resizing", () => {
  const handle = () => container.querySelector<HTMLElement>('[aria-label="Resize projects"]')!;
  const section = () => handle().parentElement!;
  const pointer = (type: string, clientY: number) =>
    act(async () => {
      handle().dispatchEvent(new MouseEvent(type, { clientY, bubbles: true }));
    });
  const key = (name: string, shiftKey = false) =>
    act(async () => {
      handle().dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true }));
    });

  // jsdom lays nothing out: the sidebar is 800px tall and the section 200px.
  beforeEach(async () => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    await render([handbook]);
    Object.defineProperty(section().parentElement!, "clientHeight", { value: 800 });
    Object.defineProperty(section(), "offsetHeight", { value: 200, configurable: true });
  });

  it("sizes to its content until the top edge is dragged, then keeps the height", async () => {
    expect(section().style.height).toBe("");

    await pointer("pointerdown", 500);
    await pointer("pointermove", 380);
    expect(section().style.height).toBe("320px");
    expect(localStorage.getItem("scratch:projectsHeight")).toBeNull();
    await pointer("pointerup", 380);
    expect(localStorage.getItem("scratch:projectsHeight")).toBe("320");

    act(() => root.unmount());
    root = createRoot(container);
    await render([handbook]);
    expect(section().style.height).toBe("320px");
  });

  it("stops at a usable minimum and leaves room for the notes list", async () => {
    await pointer("pointerdown", 500);
    await pointer("pointermove", 900);
    expect(section().style.height).toBe("96px");
    await pointer("pointermove", -400);
    expect(section().style.height).toBe("600px");
    await pointer("pointerup", -400);
  });

  it("ignores a click, resizes from the keyboard and resets on double-click", async () => {
    await pointer("pointerdown", 500);
    await pointer("pointermove", 499);
    await pointer("pointerup", 499);
    expect(section().style.height).toBe("");

    await key("ArrowUp");
    expect(section().style.height).toBe("216px");
    await key("ArrowDown", true);
    expect(section().style.height).toBe("136px");

    await act(async () => {
      handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(section().style.height).toBe("");
    expect(localStorage.getItem("scratch:projectsHeight")).toBeNull();
  });

  it("has no handle, and no fixed height, while the section is collapsed", async () => {
    await key("ArrowUp");
    await click([...container.querySelectorAll("button")].find((entry) => entry.textContent?.startsWith("Projects"))!);
    expect(container.querySelector('[aria-label="Resize projects"]')).toBeNull();
    expect(container.querySelector<HTMLElement>(".border-t")!.style.height).toBe("");
  });
});
