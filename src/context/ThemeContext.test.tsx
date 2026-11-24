// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeContext";
import { AppearanceSettingsSection } from "../components/settings/EditorSettingsSection";
import { TooltipProvider } from "../components/ui";
import type { Settings } from "../types/note";

const notesService = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("../services/notes", () => notesService);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let container: HTMLDivElement;
let storedSettings: Settings;
let systemDark = false;
let mediaListeners: Array<(e: MediaQueryListEvent) => void> = [];

function setSystemDark(next: boolean) {
  systemDark = next;
  const event = { matches: next } as MediaQueryListEvent;
  for (const listener of [...mediaListeners]) {
    listener(event);
  }
}

beforeEach(() => {
  systemDark = false;
  mediaListeners = [];
  storedSettings = {
    theme: { mode: "system" },
  };
  notesService.getSettings.mockReset().mockImplementation(async () => structuredClone(storedSettings));
  notesService.updateSettings.mockReset().mockImplementation(async (next: Settings) => {
    storedSettings = structuredClone(next);
  });

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? systemDark : false,
      media: query,
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
        mediaListeners.push(cb);
      },
      removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
        mediaListeners = mediaListeners.filter((fn) => fn !== cb);
      },
    })),
  });

  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});

describe("ThemeProvider mix-and-match themes", () => {
  it("follows system appearance and switches between independently chosen light and dark themes", async () => {
    storedSettings = {
      theme: {
        mode: "system",
        lightTheme: "alucard",
        darkTheme: "catppuccin-mocha",
      },
    };

    let ctx!: ReturnType<typeof useTheme>;
    function Probe() {
      ctx = useTheme();
      return null;
    }

    await act(async () => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });

    // System starts light -> Alucard active
    expect(ctx.theme).toBe("system");
    expect(ctx.resolvedTheme).toBe("light");
    expect(ctx.lightTheme).toBe("alucard");
    expect(ctx.darkTheme).toBe("catppuccin-mocha");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.dataset.theme).toBe("alucard");
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe("#FFFBEB");
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#644AC9");

    // OS switches to dark -> Catppuccin Mocha active
    await act(async () => {
      setSystemDark(true);
    });

    expect(ctx.resolvedTheme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("catppuccin-mocha");
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe("#1e1e2e");
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#89b4fa");
  });

  it("supports explicit light/dark modes and persists independent light & dark themes without clobbering", async () => {
    let ctx!: ReturnType<typeof useTheme>;
    function Probe() {
      ctx = useTheme();
      return null;
    }

    await act(async () => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });

    // Mix and match: Catppuccin Latte for light, Dracula for dark
    await act(async () => {
      ctx.setLightTheme("catppuccin-latte");
      ctx.setDarkTheme("dracula");
      ctx.setTheme("dark");
    });

    expect(ctx.resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dracula");
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe("#282A36");
    expect(document.documentElement.style.getPropertyValue("--color-syntax-keyword")).toBe("#FF79C6");
    expect(storedSettings.theme).toMatchObject({
      mode: "dark",
      lightTheme: "catppuccin-latte",
      darkTheme: "dracula",
    });

    // Explicit light mode applies Catppuccin Latte while keeping Dracula saved for dark
    await act(async () => {
      ctx.setTheme("light");
    });

    expect(ctx.resolvedTheme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.dataset.theme).toBe("catppuccin-latte");
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe("#eff1f5");
    expect(storedSettings.theme).toMatchObject({
      mode: "light",
      lightTheme: "catppuccin-latte",
      darkTheme: "dracula",
    });
  });

  it("clears custom overrides only for the mode whose preset changed", async () => {
    storedSettings = {
      theme: { mode: "light", lightTheme: "default", darkTheme: "default" },
      customColorsLight: { bg: "#123456" },
      customColorsDark: { bg: "#654321" },
    };

    let ctx!: ReturnType<typeof useTheme>;
    function Probe() {
      ctx = useTheme();
      return null;
    }

    await act(async () => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });

    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe("#123456");

    await act(async () => {
      ctx.setLightTheme("alucard");
    });

    expect(ctx.customColorsLight).toEqual({});
    expect(ctx.customColorsDark).toEqual({ bg: "#654321" });
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe("#FFFBEB");
  });

  it("renders all 3 light and 3 dark theme presets in AppearanceSettingsSection and lets users mix and match", async () => {
    await act(async () => {
      root.render(
        <ThemeProvider>
          <TooltipProvider>
            <AppearanceSettingsSection />
          </TooltipProvider>
        </ThemeProvider>,
      );
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const findButton = (label: string) =>
      buttons.find((btn) => btn.textContent?.trim() === label);

    const alucardBtn = findButton("Alucard");
    const draculaBtn = findButton("Dracula");
    const latteBtn = findButton("Catppuccin Latte");
    const mochaBtn = findButton("Catppuccin Mocha");
    const darkModeBtn = findButton("Dark");

    expect(alucardBtn).toBeTruthy();
    expect(draculaBtn).toBeTruthy();
    expect(latteBtn).toBeTruthy();
    expect(mochaBtn).toBeTruthy();

    // Select Alucard for light and Dracula for dark
    await act(async () => {
      alucardBtn!.click();
    });
    expect(document.documentElement.dataset.theme).toBe("alucard");

    await act(async () => {
      draculaBtn!.click();
      darkModeBtn!.click();
    });
    expect(document.documentElement.dataset.theme).toBe("dracula");
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe("#282A36");
    expect(storedSettings.theme).toMatchObject({
      mode: "dark",
      lightTheme: "alucard",
      darkTheme: "dracula",
    });
  });
});
