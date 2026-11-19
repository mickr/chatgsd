// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolsSettingsSection } from "./ToolsSettingsSection";

const state = vi.hoisted(() => ({ agent: {} as Record<string, unknown> }));
vi.mock("../../context/AgentContext", () => ({ useAgent: () => state.agent }));
vi.mock("./AboutYouSettings", () => ({ AboutYouSettings: () => null }));
vi.mock("../../services/cli", () => ({
  getCliStatus: () => Promise.resolve({ supported: false, installed: false, path: null }),
}));
vi.mock("../../services/agent", () => ({
  researchBriefDefault: () => Promise.resolve("Prefer primary sources."),
  setupComputerPermissions: vi.fn(),
  isAntigravityModel: (id: string | null | undefined) => typeof id === "string" && id.startsWith("agy:"),
  openExternalUrl: vi.fn(() => Promise.resolve()),
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

it("offers on-demand Antigravity CLI installation when agy is not found", async () => {
  const installAntigravity = vi.fn();
  state.agent = {
    ...state.agent,
    antigravityEnabled: true,
    setAntigravityEnabled: vi.fn(),
    antigravityStatus: {
      status: "unavailable",
      detail: "Antigravity CLI (`agy`) was not found on this Mac.",
      binaryPath: null,
    },
    antigravityLoading: false,
    antigravityError: null,
    antigravityInstalling: false,
    antigravityInstallProgress: null,
    installAntigravity,
    refreshAntigravityStatus: vi.fn(),
  };
  await act(async () => { root.render(<ToolsSettingsSection />); });
  const installButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Install Antigravity CLI",
  )!;
  expect(installButton).toBeTruthy();
  act(() => installButton.click());
  expect(installAntigravity).toHaveBeenCalledTimes(1);
});

it("lets the user paste an authorization code or callback URL to finish Antigravity sign-in", async () => {
  const completeAntigravitySignIn = vi.fn();
  const cancelAntigravitySignIn = vi.fn();
  state.agent = {
    ...state.agent,
    antigravityEnabled: true,
    setAntigravityEnabled: vi.fn(),
    antigravityStatus: {
      status: "signed_out",
      detail: "Sign in with Google to use Antigravity models.",
      binaryPath: "/usr/local/bin/agy",
    },
    antigravityLoading: false,
    antigravityError: null,
    antigravitySigningIn: false,
    antigravityAuthUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test",
    signInAntigravity: vi.fn(),
    completeAntigravitySignIn,
    cancelAntigravitySignIn,
    refreshAntigravityStatus: vi.fn(),
  };
  await act(async () => { root.render(<ToolsSettingsSection />); });
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Antigravity authorization code or callback URL"]',
  )!;
  expect(input).toBeTruthy();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "  4/0AeanS0-sample-code  ",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submitButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Finish sign-in",
  )!;
  expect(submitButton).toBeTruthy();
  act(() => submitButton.click());
  expect(completeAntigravitySignIn).toHaveBeenCalledWith("4/0AeanS0-sample-code");

  const cancelButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Cancel",
  )!;
  act(() => cancelButton.click());
  expect(cancelAntigravitySignIn).toHaveBeenCalledTimes(1);
});
