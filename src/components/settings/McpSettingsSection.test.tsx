// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as McpService from "../../services/mcp";
import type { McpServer } from "../../services/mcp";
import { McpSettingsSection } from "./McpSettingsSection";

const state = vi.hoisted(() => ({ servers: [] as unknown[] }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("../../context/McpContext", () => ({
  useMcp: () => ({ servers: state.servers, error: null, refresh: vi.fn() }),
}));
vi.mock("../../services/mcp", async (original) => ({
  ...await original<typeof McpService>(),
  redirectUri: vi.fn(() => Promise.resolve("http://127.0.0.1:47823/callback")),
  addServer: vi.fn(),
  addLocalServer: vi.fn(),
  addFoundServer: vi.fn(),
  loadConfig: vi.fn(() => Promise.resolve({ problem: null, found: [] })),
  revealConfig: vi.fn(() => Promise.resolve()),
  updateServer: vi.fn(() => Promise.resolve()),
  removeServer: vi.fn(() => Promise.resolve()),
  setServerEnabled: vi.fn(() => Promise.resolve()),
  connectServer: vi.fn(() => Promise.resolve()),
  authorizeServer: vi.fn(() => Promise.resolve()),
  cancelAuthorize: vi.fn(() => Promise.resolve()),
  signOutServer: vi.fn(() => Promise.resolve()),
  setToolPolicy: vi.fn(() => Promise.resolve()),
}));
const mcp = await import("../../services/mcp");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;

const tracker: McpServer = {
  id: "s1", name: "Tracker", key: "tracker", url: "https://mcp.tracker.example/mcp", command: null, transport: "http",
  enabled: true, local: false,
  clientId: null, auth: "oauth", status: "connected", detail: null,
  tools: [
    { name: "search_issues", title: null, description: "Find issues", readOnly: true, policy: "allow" },
    { name: "create_issue", title: null, description: "Open an issue", readOnly: false, policy: "ask" },
  ],
};

async function render(servers: McpServer[]) {
  state.servers = servers;
  await act(async () => { root.render(<McpSettingsSection />); });
}
const settle = () => act(async () => { for (let tick = 0; tick < 5; tick++) await Promise.resolve(); });
const button = (label: string, within: ParentNode = document.body) =>
  [...within.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
function type(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

it("adds a server from its address alone and opens its sign-in when it asks for one", async () => {
  vi.mocked(mcp.addServer).mockResolvedValue({ ...tracker, auth: "none", status: "needs_auth", tools: [] });
  await render([]);
  expect(container.textContent).toContain("No servers yet");
  const address = container.querySelector<HTMLInputElement>('input[aria-label="Address of an MCP server"]')!;
  expect(button("Add server").disabled).toBe(true);
  type(address, "mcp.tracker.example/mcp");
  await act(async () => { button("Add server").click(); });
  await settle();

  expect(mcp.addServer).toHaveBeenCalledWith({ url: "mcp.tracker.example/mcp", name: undefined, token: undefined, clientId: undefined });
  expect(mcp.authorizeServer).toHaveBeenCalledWith("s1");
  expect(address.value).toBe("");
});

it("keeps the address and says why when a server can't be added", async () => {
  vi.mocked(mcp.addServer).mockRejectedValue("Use an https address for a server on the internet");
  await render([]);
  const address = container.querySelector<HTMLInputElement>('input[aria-label="Address of an MCP server"]')!;
  type(address, "http://mcp.tracker.example/mcp");
  await act(async () => { button("Add server").click(); });
  await settle();

  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Use an https address for a server on the internet");
  expect(address.value).toBe("http://mcp.tracker.example/mcp");
  expect(mcp.authorizeServer).not.toHaveBeenCalled();
});

it("offers the controls a server's state calls for", async () => {
  await render([tracker]);
  expect(container.textContent).toContain("Connected");
  expect(container.textContent).toContain("2 tools · 1 ask first");
  act(() => button("Reconnect").click());
  expect(mcp.connectServer).toHaveBeenCalledWith("s1");
  await settle();
  act(() => button("Sign in again").click());
  expect(mcp.authorizeServer).toHaveBeenCalledWith("s1");
  await settle();
  act(() => button("Sign out").click());
  expect(mcp.signOutServer).toHaveBeenCalledWith("s1");
  await settle();
  act(() => container.querySelector<HTMLInputElement>('input[aria-label="Let the agent use Tracker"]')!.click());
  expect(mcp.setServerEnabled).toHaveBeenCalledWith("s1", false);
  await settle();

  await render([{ ...tracker, auth: "none", status: "needs_auth" }]);
  expect(button("Sign in")).toBeTruthy();
  expect(button("Sign out")).toBeUndefined();

  await render([{ ...tracker, status: "authorizing" }]);
  expect(container.textContent).toContain("Finish signing in in your browser");
  act(() => button("Cancel").click());
  expect(mcp.cancelAuthorize).toHaveBeenCalledWith("s1");

  await render([{ ...tracker, status: "error", detail: "Couldn't reach mcp.tracker.example" }]);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't reach mcp.tracker.example");
});

it("changes what the agent may do with one tool", async () => {
  await render([tracker]);
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="When the agent wants to use create_issue on Tracker"]')!;
  expect(select.value).toBe("ask");
  act(() => {
    select.value = "off";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(mcp.setToolPolicy).toHaveBeenCalledWith("s1", "create_issue", "off");
});

it("edits a server without touching a saved token left blank", async () => {
  await render([{ ...tracker, auth: "token" }]);
  act(() => button("Edit").click());
  const form = container.querySelector<HTMLFormElement>('form[aria-label="Edit Tracker"]')!;
  type(form.querySelector<HTMLInputElement>("#mcp-edit-s1-name")!, "Work tracker");
  await act(async () => { button("Save", form).click(); });
  await settle();
  expect(mcp.updateServer).toHaveBeenCalledWith("s1", {
    url: "https://mcp.tracker.example/mcp", name: "Work tracker", token: undefined, clientId: "",
  });
  expect(container.querySelector('form[aria-label="Edit Tracker"]')).toBeNull();

  act(() => button("Edit").click());
  await act(async () => { button("Remove saved token").click(); });
  await settle();
  expect(vi.mocked(mcp.updateServer).mock.calls[1][1].token).toBe("");
});

it("removes a server only after confirming", async () => {
  await render([tracker]);
  act(() => button("Remove", container).click());
  expect(mcp.removeServer).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Remove this server?");
  const dialog = document.body.querySelector('[role="alertdialog"]')!;
  await act(async () => { button("Remove", dialog).click(); });
  expect(mcp.removeServer).toHaveBeenCalledWith("s1");
});

const files: McpServer = {
  id: "program-1", name: "files", key: "files", url: "", command: "npx -y files-server ~/Documents", transport: "stdio",
  enabled: true, local: true, clientId: null, auth: "none", status: "connected", detail: null,
  tools: [{ name: "read_file", title: null, description: "Read a file", readOnly: true, policy: "allow" }],
};

it("adds a server that runs on this Mac from its command, under More options", async () => {
  vi.mocked(mcp.addLocalServer).mockResolvedValue(files);
  await render([]);
  expect(container.querySelector("#mcp-local-command")).toBeNull();
  act(() => button("More options").click());
  expect(button("Add local server").disabled).toBe(true);
  type(container.querySelector<HTMLInputElement>("#mcp-local-name")!, "files");
  type(container.querySelector<HTMLInputElement>("#mcp-local-command")!, "npx -y files-server ~/Documents");
  type(container.querySelector<HTMLTextAreaElement>("#mcp-local-env")!, "API_KEY=abc\n");
  await act(async () => { button("Add local server").click(); });
  await settle();

  expect(mcp.addLocalServer).toHaveBeenCalledWith({ name: "files", command: "npx -y files-server ~/Documents", env: "API_KEY=abc" });
  expect(toast.success).toHaveBeenCalledWith("Connected to files.");
  expect(container.querySelector<HTMLInputElement>("#mcp-local-command")!.value).toBe("");
  expect(mcp.addServer).not.toHaveBeenCalled();

  vi.mocked(mcp.addLocalServer).mockRejectedValue("Close the quote in the command");
  type(container.querySelector<HTMLInputElement>("#mcp-local-name")!, "notes");
  type(container.querySelector<HTMLInputElement>("#mcp-local-command")!, "uvx 'notes");
  await act(async () => { button("Add local server").click(); });
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Close the quote in the command");
  expect(container.querySelector<HTMLInputElement>("#mcp-local-command")!.value).toBe("uvx 'notes");
});

it("shows a local server by its command and sends its edits to mcp.json", async () => {
  await render([files]);
  expect(container.textContent).toContain("npx -y files-server ~/Documents · runs on this Mac");
  expect(button("Sign in again")).toBeUndefined();
  expect(button("Edit")).toBeUndefined();
  act(() => button("Edit in mcp.json").click());
  expect(mcp.revealConfig).toHaveBeenCalled();

  act(() => button("Remove", container).click());
  expect(document.body.querySelector('[role="alertdialog"]')!.textContent).toContain("takes it out of mcp.json");
});

it("follows mcp.json on opening and on coming back, and says what it can't use", async () => {
  vi.mocked(mcp.loadConfig).mockResolvedValue({ problem: "mcp.json isn't valid JSON: expected value at line 3", found: [] });
  await render([files]);
  await settle();
  expect(mcp.loadConfig).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("isn't valid JSON");

  vi.mocked(mcp.loadConfig).mockResolvedValue({ problem: null, found: [] });
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await settle();
  expect(mcp.loadConfig).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("isn't valid JSON");
});

it("offers the servers Codex has and adds one when asked", async () => {
  vi.mocked(mcp.loadConfig).mockResolvedValue({ problem: null, found: [{ name: "browser", detail: "/Applications/Browser.app/Contents/MacOS/browser mcp" }] });
  vi.mocked(mcp.addFoundServer).mockResolvedValue({ ...files, id: "program-2", name: "browser" });
  await render([]);
  await settle();
  expect(container.textContent).toContain("Already set up in Codex");
  expect(mcp.addFoundServer).not.toHaveBeenCalled();
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Add browser from Codex"]')!.click(); });
  await settle();
  expect(mcp.addFoundServer).toHaveBeenCalledWith("browser");
  expect(toast.success).toHaveBeenCalledWith("Connected to browser.");
  expect(mcp.loadConfig).toHaveBeenCalledTimes(2);
});
