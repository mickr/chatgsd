// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolsSettingsSection } from "./ToolsSettingsSection";

const state = vi.hoisted(() => ({ agent: {} as Record<string, unknown> }));
vi.mock("../../context/AgentContext", () => ({ useAgent: () => state.agent }));
vi.mock("../../services/cli", () => ({
  getCliStatus: () => Promise.resolve({ supported: false, installed: false, path: null }),
}));
vi.mock("../../services/agent", () => ({
  researchBriefDefault: () => Promise.resolve("Prefer primary sources."),
  setupComputerPermissions: vi.fn(),
  isAntigravityModel: (id: string | null | undefined) => typeof id === "string" && id.startsWith("agy:"),
  errorMessage: String,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
const setResearchBrief = vi.fn();

beforeEach(async () => {
  setResearchBrief.mockClear();
  state.agent = {
    status: null, statusLoading: false, statusError: null,
    refreshStatus: () => Promise.resolve(),
    computerAccess: true, setComputerAccess: vi.fn(),
    webAccess: true, setWebAccess: vi.fn(),
    models: [{ id: "gpt-6-luna", label: "GPT-6-Luna" }], modelsLoading: false,
    researchModel: "gpt-6-luna", setResearchModel: vi.fn(),
    researchBrief: null, setResearchBrief,
  };
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => { root.render(<ToolsSettingsSection />); });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

const brief = () => container.querySelector<HTMLTextAreaElement>("#research-brief")!;
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(brief(), text);
    brief().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("keeps a typed brief when a shortcut closes settings before the field loses focus", () => {
  expect(brief().value).toBe("Prefer primary sources.");
  type("  Only official documentation.  ");
  expect(setResearchBrief).not.toHaveBeenCalled();
  act(() => root.unmount());
  expect(setResearchBrief).toHaveBeenCalledTimes(1);
  expect(setResearchBrief).toHaveBeenCalledWith("Only official documentation.");
  root = createRoot(container);
});

it("saves nothing on the way out after a reset or with nothing typed", () => {
  act(() => root.unmount());
  expect(setResearchBrief).not.toHaveBeenCalled();
  root = createRoot(container);
  act(() => root.render(<ToolsSettingsSection />));
  type("Draft to throw away.");
  const reset = [...container.querySelectorAll("button")].find((button) => button.textContent === "Reset to default")!;
  act(() => reset.click());
  expect(setResearchBrief).toHaveBeenLastCalledWith(null);
  act(() => root.unmount());
  expect(setResearchBrief).toHaveBeenCalledTimes(1);
  root = createRoot(container);
});

it("renders the Antigravity integration card and toggles it", async () => {
  const setAntigravityEnabled = vi.fn();
  state.agent = {
    ...state.agent,
    antigravityEnabled: true,
    setAntigravityEnabled,
    antigravityStatus: { status: "ready", detail: null, binaryPath: "/usr/local/bin/agy" },
    antigravityLoading: false,
    antigravityError: null,
    antigravitySigningIn: false,
    refreshAntigravityStatus: vi.fn(),
    signInAntigravity: vi.fn(),
  };
  await act(async () => { root.render(<ToolsSettingsSection />); });
  expect(container.textContent).toContain("Antigravity");
  expect(container.textContent).toContain("Using your local Antigravity plan");
  const toggle = [...container.querySelectorAll<HTMLInputElement>("input[type='checkbox']")]
    .find((input) => input.getAttribute("aria-describedby") === "antigravity-description")!;
  expect(toggle.checked).toBe(true);
  act(() => toggle.click());
  expect(setAntigravityEnabled).toHaveBeenCalledWith(false);
});
