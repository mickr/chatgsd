// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as McpService from "../../services/mcp";
import type { McpServer } from "../../services/mcp";
import { McpServices } from "./McpServices";

const state = vi.hoisted(() => ({ servers: null as unknown }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("../../context/McpContext", () => ({
  useMcp: () => ({ servers: state.servers, error: null, refresh: vi.fn() }),
}));
vi.mock("../../services/mcp", async (original) => ({
  ...await original<typeof McpService>(),
  setServerEnabled: vi.fn(() => Promise.resolve()),
  connectServer: vi.fn(() => Promise.resolve()),
  authorizeServer: vi.fn(() => Promise.resolve()),
  cancelAuthorize: vi.fn(() => Promise.resolve()),
}));
const mcp = await import("../../services/mcp");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
const onManage = vi.fn();

const server = (change: Partial<McpServer>): McpServer => ({
  id: "s1", name: "Tracker", key: "tracker", url: "https://mcp.tracker.example/mcp", command: null, transport: "http",
  enabled: true, local: false,
  clientId: null, auth: "oauth", status: "connected", detail: null, tools: [], ...change,
});
let renders = 0;
// The component is memoized and the context is mocked, so each render is keyed anew.
function render(servers: McpServer[] | null) {
  state.servers = servers;
  act(() => root.render(<McpServices key={renders++} onManage={onManage} />));
}
const trigger = () => container.querySelector<HTMLButtonElement>(".agent-panel-services-trigger")!;
const openMenu = () =>
  act(() => { trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
const item = (label: string) =>
  [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')]
    .find((entry) => entry.textContent?.includes(label))!;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

it("stays out of the way until servers load, then points to settings when there are none", () => {
  render(null);
  expect(container.textContent).toBe("");
  render([]);
  act(() => container.querySelector("button")!.click());
  expect(onManage).toHaveBeenCalledTimes(1);
});

it("names the services that are on and flags the ones needing attention", () => {
  render([
    server({}),
    server({ id: "s2", name: "Calendar", status: "needs_auth" }),
    server({ id: "s3", name: "Wiki", enabled: false }),
  ]);
  expect(trigger().textContent).toBe("Tracker, Calendar");
  expect(trigger().getAttribute("aria-label")).toBe("Services the agent can use: Tracker, Calendar. 1 need attention");

  render([server({ enabled: false })]);
  expect(trigger().textContent).toBe("Services off");
});

it("turns a service off, signs in, reconnects and opens settings from the menu", () => {
  render([
    server({}),
    server({ id: "s2", name: "Calendar", status: "needs_auth" }),
    server({ id: "s3", name: "Wiki", status: "error", detail: "Couldn't reach wiki.example" }),
  ]);
  openMenu();
  expect(item("Tracker").getAttribute("aria-checked")).toBe("true");
  act(() => item("Tracker").click());
  expect(mcp.setServerEnabled).toHaveBeenCalledWith("s1", false);
  expect(item("Tracker"), "the menu stays open while a service changes").toBeTruthy();

  act(() => item("Reconnect Wiki").click());
  expect(mcp.connectServer).toHaveBeenCalledWith("s3");
  act(() => item("Sign in to Calendar").click());
  expect(mcp.authorizeServer).toHaveBeenCalledWith("s2");

  openMenu();
  act(() => item("Manage MCP servers").click());
  expect(onManage).toHaveBeenCalledTimes(1);
});
