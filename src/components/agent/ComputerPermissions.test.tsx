// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerPermissions } from "./ComputerPermissions";
import { setupComputerPermissions } from "../../services/agent";

vi.mock("../../lib/platform", () => ({ isMac: true }));
vi.mock("../../services/agent", () => ({ setupComputerPermissions: vi.fn(), errorMessage: String }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("opens only the missing permission and only after an explicit click", async () => {
  vi.mocked(setupComputerPermissions).mockResolvedValue("Enable ChatGSD.");
  act(() => root.render(<ComputerPermissions permissions={["screen_recording"]} />));
  expect(setupComputerPermissions).not.toHaveBeenCalled();
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(container.querySelector("button")?.textContent).toBe("Open Screen Recording");
  await act(async () => { container.querySelector("button")!.click(); });
  expect(setupComputerPermissions).toHaveBeenCalledWith("screen_recording");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Enable ChatGSD.");
});

it("provides both settings links and reports failures without trapping the user", async () => {
  vi.mocked(setupComputerPermissions).mockRejectedValue("Could not open System Settings");
  act(() => root.render(<ComputerPermissions />));
  expect(container.querySelectorAll("button")).toHaveLength(2);
  await act(async () => { container.querySelector("button")!.click(); });
  expect(setupComputerPermissions).toHaveBeenCalledWith("accessibility");
  expect(container.textContent).toContain("Could not open System Settings");
  expect(container.querySelector("button")!.disabled).toBe(false);
});

it("does not suggest permissions for a driver failure", () => {
  act(() => root.render(<ComputerPermissions permissions={[]} />));
  expect(container.querySelector("button")).toBeNull();
});
