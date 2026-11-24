import type { ThemeColorKey } from "../types/note";

export type LightThemeId = "default" | "alucard" | "catppuccin-latte";
export type DarkThemeId = "default" | "dracula" | "catppuccin-mocha";
export type ThemePresetId = LightThemeId | DarkThemeId;

export interface ThemeSyntaxColors {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  variable: string;
  type: string;
  operator: string;
  attr: string;
  code: string;
}

export interface ThemePreset<Id extends string = string> {
  id: Id;
  name: string;
  mode: "light" | "dark";
  colors: Record<ThemeColorKey, string>;
  textInverse: string;
  syntax: ThemeSyntaxColors;
  /** Representative palette accents shown in the theme picker preview */
  previewAccents: [string, string, string];
}

export const LIGHT_THEMES: readonly ThemePreset<LightThemeId>[] = [
  {
    id: "default",
    name: "Default",
    mode: "light",
    colors: {
      bg: "#ffffff",
      "bg-secondary": "#fafaf9",
      "bg-muted": "rgba(28, 25, 23, 0.06)",
      "bg-emphasis": "rgba(28, 25, 23, 0.09)",
      text: "#1c1917",
      "text-muted": "#78716c",
      border: "rgba(28, 25, 23, 0.08)",
      accent: "#1c1917",
      selection: "rgba(250, 204, 21, 0.4)",
    },
    textInverse: "#fafaf9",
    syntax: {
      keyword: "#d73a49",
      string: "#032f62",
      number: "#005cc5",
      comment: "#6a737d",
      function: "#6f42c1",
      variable: "#e36209",
      type: "#22863a",
      operator: "#d73a49",
      attr: "#005cc5",
      code: "#d73a49",
    },
    previewAccents: ["#1c1917", "#78716c", "#facc15"],
  },
  {
    // Official Alucard Classic palette from https://draculatheme.com/spec
    id: "alucard",
    name: "Alucard",
    mode: "light",
    colors: {
      bg: "#FFFBEB",
      "bg-secondary": "#EFEDDC",
      "bg-muted": "rgba(108, 102, 75, 0.09)",
      "bg-emphasis": "rgba(108, 102, 75, 0.16)",
      text: "#1F1F1F",
      "text-muted": "#6C664B",
      border: "rgba(108, 102, 75, 0.22)",
      accent: "#644AC9",
      selection: "#CFCFDE",
    },
    textInverse: "#FFFBEB",
    syntax: {
      keyword: "#A3144D",
      string: "#846E15",
      number: "#A34D14",
      comment: "#6C664B",
      function: "#14710A",
      variable: "#644AC9",
      type: "#036A96",
      operator: "#A3144D",
      attr: "#14710A",
      code: "#A3144D",
    },
    previewAccents: ["#644AC9", "#A3144D", "#14710A"],
  },
  {
    // Official Catppuccin Latte palette
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    mode: "light",
    colors: {
      bg: "#eff1f5",
      "bg-secondary": "#e6e9ef",
      "bg-muted": "rgba(76, 79, 105, 0.08)",
      "bg-emphasis": "rgba(76, 79, 105, 0.14)",
      text: "#4c4f69",
      "text-muted": "#6c6f85",
      border: "rgba(76, 79, 105, 0.15)",
      accent: "#1e66f5",
      selection: "rgba(172, 176, 190, 0.45)",
    },
    textInverse: "#ffffff",
    syntax: {
      keyword: "#8839ef",
      string: "#40a02b",
      number: "#fe640b",
      comment: "#8c8fa1",
      function: "#1e66f5",
      variable: "#d20f39",
      type: "#df8e1d",
      operator: "#179299",
      attr: "#1e66f5",
      code: "#d20f39",
    },
    previewAccents: ["#1e66f5", "#8839ef", "#40a02b"],
  },
];

export const DARK_THEMES: readonly ThemePreset<DarkThemeId>[] = [
  {
    id: "default",
    name: "Default",
    mode: "dark",
    colors: {
      bg: "rgb(22, 20, 19)",
      "bg-secondary": "rgb(14, 12, 11)",
      "bg-muted": "rgba(250, 249, 249, 0.05)",
      "bg-emphasis": "rgba(250, 249, 249, 0.08)",
      text: "#fafaf9",
      "text-muted": "#a8a29e",
      border: "rgba(250, 249, 249, 0.07)",
      accent: "#fafaf9",
      selection: "rgba(253, 224, 71, 0.35)",
    },
    textInverse: "#0c0a09",
    syntax: {
      keyword: "#ea4a5a",
      string: "#79b8ff",
      number: "#79b8ff",
      comment: "#959da5",
      function: "#b392f0",
      variable: "#fb8532",
      type: "#7bcc72",
      operator: "#ea4a5a",
      attr: "#79b8ff",
      code: "#ea4a5a",
    },
    previewAccents: ["#fafaf9", "#a8a29e", "#fde047"],
  },
  {
    // Official Dracula Classic palette from https://draculatheme.com/spec
    id: "dracula",
    name: "Dracula",
    mode: "dark",
    colors: {
      bg: "#282A36",
      "bg-secondary": "#21222C",
      "bg-muted": "rgba(68, 71, 90, 0.55)",
      "bg-emphasis": "rgba(68, 71, 90, 0.85)",
      text: "#F8F8F2",
      "text-muted": "#6272A4",
      border: "rgba(98, 114, 164, 0.25)",
      accent: "#BD93F9",
      selection: "#44475A",
    },
    textInverse: "#282A36",
    syntax: {
      keyword: "#FF79C6",
      string: "#F1FA8C",
      number: "#FFB86C",
      comment: "#6272A4",
      function: "#50FA7B",
      variable: "#BD93F9",
      type: "#8BE9FD",
      operator: "#FF79C6",
      attr: "#50FA7B",
      code: "#FF79C6",
    },
    previewAccents: ["#BD93F9", "#FF79C6", "#50FA7B"],
  },
  {
    // Official Catppuccin Mocha palette
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    mode: "dark",
    colors: {
      bg: "#1e1e2e",
      "bg-secondary": "#181825",
      "bg-muted": "rgba(205, 214, 244, 0.07)",
      "bg-emphasis": "rgba(205, 214, 244, 0.13)",
      text: "#cdd6f4",
      "text-muted": "#a6adc8",
      border: "rgba(205, 214, 244, 0.11)",
      accent: "#89b4fa",
      selection: "rgba(137, 180, 250, 0.28)",
    },
    textInverse: "#11111b",
    syntax: {
      keyword: "#cba6f7",
      string: "#a6e3a1",
      number: "#fab387",
      comment: "#7f849c",
      function: "#89b4fa",
      variable: "#f38ba8",
      type: "#f9e2af",
      operator: "#94e2d5",
      attr: "#89b4fa",
      code: "#f38ba8",
    },
    previewAccents: ["#89b4fa", "#cba6f7", "#a6e3a1"],
  },
];

export const DEFAULT_LIGHT_THEME: LightThemeId = "default";
export const DEFAULT_DARK_THEME: DarkThemeId = "default";

const lightThemeMap = new Map<LightThemeId, ThemePreset<LightThemeId>>(
  LIGHT_THEMES.map((preset) => [preset.id, preset]),
);

const darkThemeMap = new Map<DarkThemeId, ThemePreset<DarkThemeId>>(
  DARK_THEMES.map((preset) => [preset.id, preset]),
);

export function isLightThemeId(value: unknown): value is LightThemeId {
  return typeof value === "string" && lightThemeMap.has(value as LightThemeId);
}

export function isDarkThemeId(value: unknown): value is DarkThemeId {
  return typeof value === "string" && darkThemeMap.has(value as DarkThemeId);
}

export function getLightThemePreset(id: LightThemeId): ThemePreset<LightThemeId> {
  return lightThemeMap.get(id) ?? LIGHT_THEMES[0];
}

export function getDarkThemePreset(id: DarkThemeId): ThemePreset<DarkThemeId> {
  return darkThemeMap.get(id) ?? DARK_THEMES[0];
}

export function getThemePreset(
  mode: "light" | "dark",
  id: LightThemeId | DarkThemeId,
): ThemePreset {
  if (mode === "dark") {
    return getDarkThemePreset(isDarkThemeId(id) ? id : DEFAULT_DARK_THEME);
  }
  return getLightThemePreset(isLightThemeId(id) ? id : DEFAULT_LIGHT_THEME);
}
