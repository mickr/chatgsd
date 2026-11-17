// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUpdateMenu } from "./useUpdateMenu";

const mocks = vi.hoisted(() => ({
  handler: null as (() => Promise<void>) | null,
  unlisten: vi.fn(),
  loading: vi.fn(() => "checking"), success: vi.fn(), error: vi.fn(), dismiss: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ listen: async (_event: string, handler: () => Promise<void>) => {
    mocks.handler = handler;
    return mocks.unlisten;
  } }),
}));
vi.mock("sonner", () => ({ toast: mocks }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
function Harness({ check }: { check: () => Promise<"update" | "no-update" | "error"> }) {
  useUpdateMenu(check);
  return null;
}
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it.each(["update", "no-update", "error"] as const)("reports a %s result without leaving the checking indicator", async (result) => {
  act(() => root.render(<Harness check={async () => result} />));
  await act(async () => { await mocks.handler!(); });
  expect(mocks.loading).toHaveBeenCalledOnce();
  if (result === "no-update") {
    expect(mocks.success).toHaveBeenCalledWith("You're on the latest version!", { id: "checking" });
    expect(mocks.error).not.toHaveBeenCalled();
  } else if (result === "error") {
    expect(mocks.error).toHaveBeenCalledWith("Could not check for updates. Try again later.", { id: "checking" });
    expect(mocks.success).not.toHaveBeenCalled();
  } else {
    expect(mocks.dismiss).toHaveBeenCalledWith("checking");
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  }
});

it("ignores repeated clicks during a check but allows a later check", async () => {
  let finish!: (result: "no-update") => void;
  const pending = new Promise<"no-update">((resolve) => { finish = resolve; });
  const check = vi.fn(() => pending);
  act(() => root.render(<Harness check={check} />));
  const first = mocks.handler!();
  await mocks.handler!();
  expect(check).toHaveBeenCalledOnce();
  finish("no-update");
  await first;
  await mocks.handler!();
  expect(check).toHaveBeenCalledTimes(2);
});
