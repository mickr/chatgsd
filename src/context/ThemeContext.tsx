import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getSettings, updateSettings } from "../services/notes";
import { SIDEBAR_MIN_PX, SIDEBAR_MAX_PX } from "../lib/sidebar";
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  getDarkThemePreset,
  getLightThemePreset,
  isDarkThemeId,
  isLightThemeId,
  type DarkThemeId,
  type LightThemeId,
  type ThemePreset,
} from "../lib/themes";
import type {
  ThemeSettings,
  EditorFontSettings,
  FontFamily,
  TextDirection,
  EditorWidth,
  CustomColors,
  ThemeColorKey,
} from "../types/note";

export type ThemeMode = "light" | "dark" | "system";

// Font family CSS values
const fontFamilyMap: Record<FontFamily, string> = {
  "system-sans":
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  monospace:
    "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, 'Courier New', monospace",
};

// Editor width CSS values for presets
const editorWidthMap: Record<Exclude<EditorWidth, "custom">, string> = {
  narrow: "36rem",
  normal: "48rem",
  wide: "64rem",
  full: "100%",
};

// Default custom width in px
const DEFAULT_CUSTOM_WIDTH_PX = 768;

// Default editor font settings (simplified)
const defaultEditorFontSettings: Required<EditorFontSettings> = {
  baseFontFamily: "system-sans",
  baseFontSize: 15,
  boldWeight: 600,
  lineHeight: 1.6,
};

// Default theme colors (must match App.css :root / .dark values)
const defaultThemeColors: Record<"light" | "dark", Record<ThemeColorKey, string>> = {
  light: getLightThemePreset(DEFAULT_LIGHT_THEME).colors,
  dark: getDarkThemePreset(DEFAULT_DARK_THEME).colors,
};

export { defaultThemeColors };

// Normalize any CSS color string (hex, rgb(), rgba(), hsl(), named) to an RGB
// triple by letting the browser parse it via getComputedStyle.
function parseCssColorToRgb(value: string): [number, number, number] | null {
  if (typeof document === "undefined") return null;
  const probe = document.createElement("div");
  probe.style.color = value;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  const match = computed.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

interface ThemeUpdatePayload {
  theme?: ThemeSettings;
  customColorsLight?: CustomColors;
  customColorsDark?: CustomColors;
}

interface ThemeContextType {
  theme: ThemeMode;
  resolvedTheme: "light" | "dark";
  lightTheme: LightThemeId;
  darkTheme: DarkThemeId;
  activeThemePreset: ThemePreset;
  setTheme: (theme: ThemeMode) => void;
  setLightTheme: (themeId: LightThemeId) => void;
  setDarkTheme: (themeId: DarkThemeId) => void;
  cycleTheme: () => void;
  editorFontSettings: Required<EditorFontSettings>;
  setEditorFontSetting: <K extends keyof EditorFontSettings>(
    key: K,
    value: EditorFontSettings[K]
  ) => void;
  resetEditorFontSettings: () => void;
  reloadSettings: () => Promise<void>;
  textDirection: TextDirection;
  setTextDirection: (dir: TextDirection) => void;
  editorWidth: EditorWidth;
  setEditorWidth: (width: EditorWidth) => void;
  interfaceZoom: number;
  setInterfaceZoom: (zoomOrUpdater: number | ((prev: number) => number)) => void;
  customEditorWidthPx: number;
  setCustomEditorWidthPx: (px: number) => void;
  setEditorMaxWidthLive: (value: string) => void;
  sidebarWidthPx: number | null;
  setSidebarWidthPx: (px: number | null) => void;
  setSidebarWidthLive: (px: number) => void;
  customColorsLight: CustomColors;
  customColorsDark: CustomColors;
  setCustomColor: (mode: "light" | "dark", key: ThemeColorKey, value: string) => void;
  resetCustomColor: (mode: "light" | "dark", key: ThemeColorKey) => void;
  resetAllCustomColors: (mode: "light" | "dark") => void;
}

const ThemeContext = createContext<ThemeContextType | null>(null);

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}

interface ThemeProviderProps {
  children: ReactNode;
}

// Apply editor font CSS variables (with computed values)
function applyFontCSSVariables(fonts: Required<EditorFontSettings>) {
  const root = document.documentElement;
  const fontFamily = fontFamilyMap[fonts.baseFontFamily];
  const baseSize = fonts.baseFontSize;
  const boldWeight = fonts.boldWeight;
  const lineHeight = fonts.lineHeight;

  // Base font settings
  root.style.setProperty("--editor-font-family", fontFamily);
  root.style.setProperty("--editor-base-font-size", `${baseSize}px`);
  root.style.setProperty("--editor-bold-weight", String(boldWeight));
  root.style.setProperty("--editor-line-height", String(lineHeight));

  // Computed header sizes (based on base)
  root.style.setProperty("--editor-h1-size", `${baseSize * 2.25}px`);
  root.style.setProperty("--editor-h2-size", `${baseSize * 1.75}px`);
  root.style.setProperty("--editor-h3-size", `${baseSize * 1.5}px`);
  root.style.setProperty("--editor-h4-size", `${baseSize * 1.25}px`);
  root.style.setProperty("--editor-h5-size", `${baseSize}px`);
  root.style.setProperty("--editor-h6-size", `${baseSize}px`);

  // Fixed value for paragraph spacing
  root.style.setProperty("--editor-paragraph-spacing", "0.875em");
}

// Apply editor layout width CSS variables
function applyLayoutCSSVariables(
  width: EditorWidth,
  customWidthPx?: number
) {
  const root = document.documentElement;
  if (width === "custom" && customWidthPx) {
    root.style.setProperty("--editor-max-width", `${customWidthPx}px`);
  } else if (width !== "custom") {
    root.style.setProperty("--editor-max-width", editorWidthMap[width]);
  }
}

function isTextDirection(value: unknown): value is TextDirection {
  return value === "auto" || value === "ltr" || value === "rtl";
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

const THEME_COLOR_KEYS: readonly ThemeColorKey[] = [
  "bg",
  "bg-secondary",
  "bg-muted",
  "bg-emphasis",
  "text",
  "text-muted",
  "border",
  "accent",
  "selection",
];

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemeMode>("system");
  const [lightTheme, setLightThemeState] = useState<LightThemeId>(DEFAULT_LIGHT_THEME);
  const [darkTheme, setDarkThemeState] = useState<DarkThemeId>(DEFAULT_DARK_THEME);
  const [editorFontSettings, setEditorFontSettings] = useState<
    Required<EditorFontSettings>
  >(defaultEditorFontSettings);
  const [textDirection, setTextDirectionState] = useState<TextDirection>("auto");
  const [editorWidth, setEditorWidthState] = useState<EditorWidth>("normal");
  const [interfaceZoom, setInterfaceZoomState] = useState(1.0);
  const [customEditorWidthPx, setCustomEditorWidthPxState] = useState<number>(
    DEFAULT_CUSTOM_WIDTH_PX
  );
  const [sidebarWidthPx, setSidebarWidthPxState] = useState<number | null>(null);
  const [customColorsLight, setCustomColorsLightState] = useState<CustomColors>({});
  const [customColorsDark, setCustomColorsDarkState] = useState<CustomColors>({});
  const [isInitialized, setIsInitialized] = useState(false);

  // Refs keep the latest theme selections for race-free persistence across rapid clicks
  const themeRef = useRef<ThemeMode>(theme);
  const lightThemeRef = useRef<LightThemeId>(lightTheme);
  const darkThemeRef = useRef<DarkThemeId>(darkTheme);
  themeRef.current = theme;
  lightThemeRef.current = lightTheme;
  darkThemeRef.current = darkTheme;

  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() => {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  const applyLoadedThemeFields = useCallback((payload: ThemeUpdatePayload) => {
    if (payload.theme) {
      if (isThemeMode(payload.theme.mode)) {
        themeRef.current = payload.theme.mode;
        setThemeState(payload.theme.mode);
      }
      const nextLight = isLightThemeId(payload.theme.lightTheme)
        ? payload.theme.lightTheme
        : DEFAULT_LIGHT_THEME;
      lightThemeRef.current = nextLight;
      setLightThemeState(nextLight);

      const nextDark = isDarkThemeId(payload.theme.darkTheme)
        ? payload.theme.darkTheme
        : DEFAULT_DARK_THEME;
      darkThemeRef.current = nextDark;
      setDarkThemeState(nextDark);
    }
    setCustomColorsLightState(payload.customColorsLight ?? {});
    setCustomColorsDarkState(payload.customColorsDark ?? {});
  }, []);

  // Function to load settings from backend
  const loadSettingsFromBackend = useCallback(async () => {
    try {
      const settings = await getSettings();
      applyLoadedThemeFields({
        theme: settings.theme,
        customColorsLight: settings.customColorsLight,
        customColorsDark: settings.customColorsDark,
      });
      if (settings.editorFont) {
        // Filter out null/undefined values to preserve defaults
        const fontSettings = Object.fromEntries(
          Object.entries(settings.editorFont).filter(([, v]) => v != null)
        ) as Partial<EditorFontSettings>;
        setEditorFontSettings({
          ...defaultEditorFontSettings,
          ...fontSettings,
        });
      }
      if (isTextDirection(settings.textDirection)) {
        setTextDirectionState(settings.textDirection);
      }
      if (
        settings.editorWidth === "narrow" ||
        settings.editorWidth === "normal" ||
        settings.editorWidth === "wide" ||
        settings.editorWidth === "full" ||
        settings.editorWidth === "custom"
      ) {
        setEditorWidthState(settings.editorWidth);
      }
      if (
        typeof settings.interfaceZoom === "number" &&
        settings.interfaceZoom >= 0.7 &&
        settings.interfaceZoom <= 1.5
      ) {
        setInterfaceZoomState(settings.interfaceZoom);
      }
      if (
        typeof settings.customEditorWidthPx === "number" &&
        settings.customEditorWidthPx >= 480
      ) {
        setCustomEditorWidthPxState(settings.customEditorWidthPx);
      }
      if (
        typeof settings.sidebarWidthPx === "number" &&
        settings.sidebarWidthPx >= SIDEBAR_MIN_PX &&
        settings.sidebarWidthPx <= SIDEBAR_MAX_PX
      ) {
        setSidebarWidthPxState(settings.sidebarWidthPx);
      }
    } catch {
      // If settings can't be loaded, use defaults
    }
  }, [applyLoadedThemeFields]);

  // Reload settings from backend (exposed to context consumers)
  const reloadSettings = useCallback(async () => {
    await loadSettingsFromBackend();
  }, [loadSettingsFromBackend]);

  // Load settings from backend on mount
  useEffect(() => {
    loadSettingsFromBackend().finally(() => {
      setIsInitialized(true);
    });
  }, [loadSettingsFromBackend]);

  // Sync theme changes across windows (e.g. main window -> open preview windows)
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    try {
      listen<ThemeUpdatePayload>("theme-updated", (event) => {
        applyLoadedThemeFields(event.payload);
      })
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // Ignore outside Tauri runtime (e.g. unit tests)
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyLoadedThemeFields]);

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? "dark" : "light");
    };
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  // Resolve the actual light/dark mode and active preset to use
  const resolvedTheme = theme === "system" ? systemTheme : theme;
  const activeThemePreset = useMemo<ThemePreset>(
    () =>
      resolvedTheme === "dark"
        ? getDarkThemePreset(darkTheme)
        : getLightThemePreset(lightTheme),
    [resolvedTheme, lightTheme, darkTheme],
  );

  // Apply light/dark class to document
  useEffect(() => {
    const root = document.documentElement;
    if (resolvedTheme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [resolvedTheme]);

  // Save current theme selections to backend
  const saveThemeSettings = useCallback(
    async (options?: { clearCustomColorsMode?: "light" | "dark" }) => {
      try {
        const settings = await getSettings();
        const themeSettings: ThemeSettings = {
          ...settings.theme,
          mode: themeRef.current,
          lightTheme: lightThemeRef.current,
          darkTheme: darkThemeRef.current,
        };
        const updated = {
          ...settings,
          theme: themeSettings,
        };
        if (options?.clearCustomColorsMode === "light") {
          updated.customColorsLight = undefined;
        } else if (options?.clearCustomColorsMode === "dark") {
          updated.customColorsDark = undefined;
        }
        await updateSettings(updated);
      } catch (error) {
        console.error("Failed to save theme settings:", error);
      }
    },
    [],
  );

  const setTheme = useCallback(
    (newTheme: ThemeMode) => {
      themeRef.current = newTheme;
      setThemeState(newTheme);
      void saveThemeSettings();
    },
    [saveThemeSettings]
  );

  const setLightTheme = useCallback(
    (newLightTheme: LightThemeId) => {
      if (lightThemeRef.current === newLightTheme) return;
      lightThemeRef.current = newLightTheme;
      setLightThemeState(newLightTheme);
      setCustomColorsLightState({});
      void saveThemeSettings({ clearCustomColorsMode: "light" });
    },
    [saveThemeSettings]
  );

  const setDarkTheme = useCallback(
    (newDarkTheme: DarkThemeId) => {
      if (darkThemeRef.current === newDarkTheme) return;
      darkThemeRef.current = newDarkTheme;
      setDarkThemeState(newDarkTheme);
      setCustomColorsDarkState({});
      void saveThemeSettings({ clearCustomColorsMode: "dark" });
    },
    [saveThemeSettings]
  );

  const cycleTheme = useCallback(() => {
    const order: ThemeMode[] = ["light", "dark", "system"];
    const currentIndex = order.indexOf(theme);
    const nextIndex = (currentIndex + 1) % order.length;
    setTheme(order[nextIndex]);
  }, [theme, setTheme]);

  // Apply font CSS variables whenever font settings change
  useEffect(() => {
    applyFontCSSVariables(editorFontSettings);
  }, [editorFontSettings]);

  // Apply layout CSS variables whenever width changes
  useEffect(() => {
    applyLayoutCSSVariables(editorWidth, customEditorWidthPx);
  }, [editorWidth, customEditorWidthPx]);

  // Apply sidebar width CSS variable whenever it changes (null = no override, fallback to 16rem)
  useEffect(() => {
    if (sidebarWidthPx === null) {
      document.documentElement.style.removeProperty("--sidebar-width");
    } else {
      document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidthPx}px`);
    }
  }, [sidebarWidthPx]);

  // Apply interface zoom whenever it changes (suppress transitions during zoom)
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("zoom-no-transition");
    root.style.zoom = String(interfaceZoom);
    const raf = requestAnimationFrame(() => {
      root.classList.remove("zoom-no-transition");
    });
    return () => cancelAnimationFrame(raf);
  }, [interfaceZoom]);

  // Save font settings to backend
  const saveFontSettings = useCallback(
    async (newFontSettings: Required<EditorFontSettings>) => {
      try {
        const settings = await getSettings();
        await updateSettings({
          ...settings,
          editorFont: newFontSettings,
        });
      } catch (error) {
        console.error("Failed to save font settings:", error);
      }
    },
    []
  );

  // Update a single font setting
  const setEditorFontSetting = useCallback(
    <K extends keyof EditorFontSettings>(
      key: K,
      value: EditorFontSettings[K]
    ) => {
      setEditorFontSettings((prev) => {
        const updated = { ...prev, [key]: value };
        saveFontSettings(updated);
        return updated;
      });
    },
    [saveFontSettings]
  );

  // Reset font settings to defaults (single atomic save to avoid race conditions)
  const resetEditorFontSettings = useCallback(async () => {
    setEditorFontSettings(defaultEditorFontSettings);
    setTextDirectionState("auto");
    setEditorWidthState("normal");
    setInterfaceZoomState(1.0);
    setCustomEditorWidthPxState(DEFAULT_CUSTOM_WIDTH_PX);
    setSidebarWidthPxState(null);
    setCustomColorsLightState({});
    setCustomColorsDarkState({});
    try {
      const settings = await getSettings();
      await updateSettings({
        ...settings,
        editorFont: defaultEditorFontSettings,
        textDirection: "auto",
        editorWidth: "normal",
        interfaceZoom: 1.0,
        customEditorWidthPx: undefined,
        sidebarWidthPx: undefined,
        customColorsLight: undefined,
        customColorsDark: undefined,
      });
    } catch (error) {
      console.error("Failed to reset editor settings:", error);
    }
  }, []);

  // Save and set text direction
  const setTextDirection = useCallback(async (dir: TextDirection) => {
    setTextDirectionState(dir);
    try {
      const settings = await getSettings();
      await updateSettings({ ...settings, textDirection: dir });
    } catch (error) {
      console.error("Failed to save text direction:", error);
    }
  }, []);

  // Save and set editor width
  const setEditorWidth = useCallback(async (width: EditorWidth) => {
    setEditorWidthState(width);
    try {
      const settings = await getSettings();
      await updateSettings({ ...settings, editorWidth: width });
    } catch (error) {
      console.error("Failed to save editor width:", error);
    }
  }, []);

  // Save and set interface zoom (accepts absolute value or updater function)
  const setInterfaceZoom = useCallback(
    (zoomOrUpdater: number | ((prev: number) => number)) => {
      setInterfaceZoomState((prev) => {
        const raw =
          typeof zoomOrUpdater === "function"
            ? zoomOrUpdater(prev)
            : zoomOrUpdater;
        return Math.round(Math.min(Math.max(raw, 0.7), 1.5) * 20) / 20;
      });
    },
    [],
  );

  // Persist interface zoom changes to backend
  useEffect(() => {
    if (!isInitialized) return;
    getSettings()
      .then((settings) =>
        updateSettings({ ...settings, interfaceZoom }),
      )
      .catch((error) =>
        console.error("Failed to save interface zoom:", error),
      );
  }, [interfaceZoom, isInitialized]);

  // Set custom width in px (persists to settings)
  const setCustomEditorWidthPx = useCallback(async (px: number) => {
    setEditorWidthState("custom");
    setCustomEditorWidthPxState(px);
    try {
      const settings = await getSettings();
      await updateSettings({
        ...settings,
        editorWidth: "custom",
        customEditorWidthPx: px,
      });
    } catch (error) {
      console.error("Failed to save custom editor width:", error);
    }
  }, []);

  /**
   * Persists the clamped sidebar width to settings.
   * Pass `null` to remove the override and fall back to the CSS default.
   */
  const setSidebarWidthPx = useCallback(async (px: number | null) => {
    if (px === null) {
      setSidebarWidthPxState(null);
      try {
        const settings = await getSettings();
        await updateSettings({ ...settings, sidebarWidthPx: undefined });
      } catch (error) {
        console.error("Failed to reset sidebar width:", error);
      }
    } else {
      const clamped = Math.round(Math.min(Math.max(px, SIDEBAR_MIN_PX), SIDEBAR_MAX_PX));
      setSidebarWidthPxState(clamped);
      try {
        const settings = await getSettings();
        await updateSettings({ ...settings, sidebarWidthPx: clamped });
      } catch (error) {
        console.error("Failed to save sidebar width:", error);
      }
    }
  }, []);

  // Apply active theme preset + custom color overrides whenever theme or colors change
  useEffect(() => {
    const root = document.documentElement;
    const activeColors = resolvedTheme === "dark" ? customColorsDark : customColorsLight;
    const presetColors = activeThemePreset.colors;

    root.dataset.theme = activeThemePreset.id;

    for (const key of THEME_COLOR_KEYS) {
      const value = activeColors[key] ?? presetColors[key];
      root.style.setProperty(`--color-${key}`, value);
    }
    root.style.setProperty("--color-text-inverse", activeThemePreset.textInverse);

    // Apply syntax highlighting & inline code colors for the active preset
    const { syntax } = activeThemePreset;
    root.style.setProperty("--color-syntax-keyword", syntax.keyword);
    root.style.setProperty("--color-syntax-string", syntax.string);
    root.style.setProperty("--color-syntax-number", syntax.number);
    root.style.setProperty("--color-syntax-comment", syntax.comment);
    root.style.setProperty("--color-syntax-function", syntax.function);
    root.style.setProperty("--color-syntax-variable", syntax.variable);
    root.style.setProperty("--color-syntax-type", syntax.type);
    root.style.setProperty("--color-syntax-operator", syntax.operator);
    root.style.setProperty("--color-syntax-attr", syntax.attr);
    root.style.setProperty("--color-code", syntax.code);

    // Sync the Windows title bar to match bg-secondary (no-op on other OSes).
    const captionColor =
      activeColors["bg-secondary"] ?? presetColors["bg-secondary"];
    const rgb = parseCssColorToRgb(captionColor);
    if (rgb) {
      invoke("set_title_bar_theme", {
        isDark: resolvedTheme === "dark",
        r: rgb[0],
        g: rgb[1],
        b: rgb[2],
      }).catch(() => {});
    }
  }, [resolvedTheme, activeThemePreset, customColorsLight, customColorsDark]);

  // Set a single custom color for a given mode
  const setCustomColor = useCallback(
    async (mode: "light" | "dark", key: ThemeColorKey, value: string) => {
      const setter = mode === "light" ? setCustomColorsLightState : setCustomColorsDarkState;
      const settingsKey = mode === "light" ? "customColorsLight" : "customColorsDark";
      setter((prev) => {
        const updated = { ...prev, [key]: value };
        // Persist in background
        getSettings()
          .then((settings) => updateSettings({ ...settings, [settingsKey]: updated }))
          .catch((err) => console.error("Failed to save custom color:", err));
        return updated;
      });
    },
    [],
  );

  // Reset a single custom color back to theme preset default
  const resetCustomColor = useCallback(
    async (mode: "light" | "dark", key: ThemeColorKey) => {
      const setter = mode === "light" ? setCustomColorsLightState : setCustomColorsDarkState;
      const settingsKey = mode === "light" ? "customColorsLight" : "customColorsDark";
      setter((prev) => {
        const updated = { ...prev };
        delete updated[key];
        getSettings()
          .then((settings) =>
            updateSettings({
              ...settings,
              [settingsKey]: Object.keys(updated).length > 0 ? updated : undefined,
            }),
          )
          .catch((err) => console.error("Failed to reset custom color:", err));
        return updated;
      });
    },
    [],
  );

  // Reset all custom colors for a given mode
  const resetAllCustomColors = useCallback(
    async (mode: "light" | "dark") => {
      const setter = mode === "light" ? setCustomColorsLightState : setCustomColorsDarkState;
      const settingsKey = mode === "light" ? "customColorsLight" : "customColorsDark";
      setter({});
      try {
        const settings = await getSettings();
        await updateSettings({ ...settings, [settingsKey]: undefined });
      } catch (err) {
        console.error("Failed to reset all custom colors:", err);
      }
    },
    [],
  );

  // Live CSS variable update during drag (no persistence)
  const setEditorMaxWidthLive = useCallback((value: string) => {
    document.documentElement.style.setProperty("--editor-max-width", value);
  }, []);

  /** Updates `--sidebar-width` CSS variable immediately during drag without writing to settings. */
  const setSidebarWidthLive = useCallback((px: number) => {
    document.documentElement.style.setProperty("--sidebar-width", `${px}px`);
  }, []);

  // Don't render until initialized to prevent flash
  if (!isInitialized) {
    return null;
  }

  return (
    <ThemeContext.Provider
      value={{
        theme,
        resolvedTheme,
        lightTheme,
        darkTheme,
        activeThemePreset,
        setTheme,
        setLightTheme,
        setDarkTheme,
        cycleTheme,
        editorFontSettings,
        setEditorFontSetting,
        resetEditorFontSettings,
        reloadSettings,
        textDirection,
        setTextDirection,
        editorWidth,
        setEditorWidth,
        interfaceZoom,
        setInterfaceZoom,
        customEditorWidthPx,
        setCustomEditorWidthPx,
        setEditorMaxWidthLive,
        sidebarWidthPx,
        setSidebarWidthPx,
        setSidebarWidthLive,
        customColorsLight,
        customColorsDark,
        setCustomColor,
        resetCustomColor,
        resetAllCustomColors,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
