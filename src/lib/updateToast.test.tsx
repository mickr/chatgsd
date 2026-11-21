// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  resetInstalledUpdateState,
  showUpdateToast,
  UpdateInstalledToast,
  UpdateToast,
} from "./updateToast";

const mocks = vi.hoisted(() => {
  const toastFn = vi.fn();
  return {
    check: vi.fn(),
    invoke: vi.fn(),
    toast: Object.assign(toastFn, {
      dismiss: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    }),
  };
});

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mocks.check,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));
vi.mock("sonner", () => ({
  toast: mocks.toast,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  resetInstalledUpdateState();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function makeUpdate(overrides: Partial<Update> = {}): Update {
  return {
    version: "1.2.0",
    body: "Bug fixes and improvements",
    downloadAndInstall: vi.fn(async () => {}),
    ...overrides,
  } as unknown as Update;
}

it("shows the update toast when an update is available and reports no-update or error otherwise", async () => {
  const update = makeUpdate();
  mocks.check.mockResolvedValueOnce(update);
  await expect(showUpdateToast()).resolves.toBe("update");
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: UpdateToast }),
    { id: "update-toast", duration: Infinity, closeButton: true },
  );

  mocks.check.mockResolvedValueOnce(null);
  await expect(showUpdateToast()).resolves.toBe("no-update");

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.check.mockRejectedValueOnce(new Error("offline"));
  await expect(showUpdateToast()).resolves.toBe("error");
  consoleError.mockRestore();
});

it("installs the update and shows a finished toast with a Restart Now button", async () => {
  let finishInstall!: () => void;
  const update = makeUpdate({
    downloadAndInstall: vi.fn(
      () => new Promise<void>((resolve) => { finishInstall = resolve; }),
    ),
  });

  act(() => root.render(<UpdateToast update={update} toastId="update-toast" />));
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("Update Now");

  act(() => { button.click(); });
  expect(button.textContent).toBe("Installing...");
  expect(button.disabled).toBe(true);
  expect(update.downloadAndInstall).toHaveBeenCalledOnce();

  await act(async () => { finishInstall(); });
  expect(mocks.toast.dismiss).toHaveBeenCalledWith("update-toast");
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: UpdateInstalledToast,
      props: { version: "1.2.0" },
    }),
    { id: "update-installed-toast", duration: Infinity, closeButton: true },
  );

  // Re-checking for the already-installed version reopens the restart toast directly
  mocks.toast.mockClear();
  mocks.check.mockResolvedValueOnce(update);
  await expect(showUpdateToast()).resolves.toBe("update");
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: UpdateInstalledToast,
      props: { version: "1.2.0" },
    }),
    { id: "update-installed-toast", duration: Infinity, closeButton: true },
  );
});

it("flushes pending saves and restarts the app when Restart Now is clicked", async () => {
  let finishFlush!: () => void;
  const flushListener = (event: Event) => {
    const detail = (event as CustomEvent<{ register: (p: Promise<unknown>) => void }>).detail;
    detail.register(new Promise<void>((resolve) => { finishFlush = resolve; }));
  };
  window.addEventListener("flush-before-restart", flushListener);
  mocks.invoke.mockResolvedValueOnce(undefined);

  try {
    act(() => root.render(<UpdateInstalledToast version="1.2.0" />));
    const button = container.querySelector("button")!;
    expect(container.textContent).toContain("Update Installed");
    expect(container.textContent).toContain("Restart ChatGSD to apply v1.2.0.");
    expect(button.textContent).toBe("Restart Now");

    act(() => { button.click(); });
    expect(button.textContent).toBe("Restarting...");
    expect(button.disabled).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();

    await act(async () => { finishFlush(); });
    expect(mocks.invoke).toHaveBeenCalledWith("restart_app");
  } finally {
    window.removeEventListener("flush-before-restart", flushListener);
  }
});

it("re-enables the button and shows an error toast if install or restart fails", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  const failingUpdate = makeUpdate({
    downloadAndInstall: vi.fn(async () => {
      throw new Error("download failed");
    }),
  });
  act(() => root.render(<UpdateToast update={failingUpdate} toastId="update-toast" />));
  await act(async () => { container.querySelector("button")!.click(); });
  expect(mocks.toast.error).toHaveBeenCalledWith("Update failed. Please try again later.");
  expect(container.querySelector("button")!.disabled).toBe(false);
  expect(container.querySelector("button")!.textContent).toBe("Update Now");

  mocks.invoke.mockRejectedValueOnce(new Error("restart failed"));
  const installedEl: ReactElement = <UpdateInstalledToast version="1.2.0" />;
  act(() => root.render(installedEl));
  await act(async () => { container.querySelector("button")!.click(); });
  expect(mocks.toast.error).toHaveBeenCalledWith(
    "Could not restart ChatGSD. Please quit and reopen it manually.",
  );
  expect(container.querySelector("button")!.disabled).toBe(false);
  expect(container.querySelector("button")!.textContent).toBe("Restart Now");

  consoleError.mockRestore();
});
