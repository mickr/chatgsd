import { describe, expect, it } from "vitest";
import {
  DARK_THEMES,
  LIGHT_THEMES,
  getDarkThemePreset,
  getLightThemePreset,
  getThemePreset,
  isDarkThemeId,
  isLightThemeId,
} from "./themes";

describe("themes", () => {
  it("provides 3 light themes and 3 dark themes including Alucard and Dracula", () => {
    expect(LIGHT_THEMES).toHaveLength(3);
    expect(DARK_THEMES).toHaveLength(3);
    expect(LIGHT_THEMES.map((t) => t.id)).toEqual([
      "default",
      "alucard",
      "catppuccin-latte",
    ]);
    expect(DARK_THEMES.map((t) => t.id)).toEqual([
      "default",
      "dracula",
      "catppuccin-mocha",
    ]);
  });

  it("matches official Dracula Classic spec hex codes", () => {
    const dracula = getDarkThemePreset("dracula");
    expect(dracula.colors.bg).toBe("#282A36");
    expect(dracula.colors["bg-secondary"]).toBe("#21222C");
    expect(dracula.colors.text).toBe("#F8F8F2");
    expect(dracula.colors["text-muted"]).toBe("#6272A4");
    expect(dracula.colors.accent).toBe("#BD93F9");
    expect(dracula.colors.selection).toBe("#44475A");
    expect(dracula.syntax.keyword).toBe("#FF79C6");
    expect(dracula.syntax.string).toBe("#F1FA8C");
    expect(dracula.syntax.number).toBe("#FFB86C");
    expect(dracula.syntax.comment).toBe("#6272A4");
    expect(dracula.syntax.function).toBe("#50FA7B");
    expect(dracula.syntax.variable).toBe("#BD93F9");
    expect(dracula.syntax.type).toBe("#8BE9FD");
  });

  it("matches official Alucard Classic spec hex codes", () => {
    const alucard = getLightThemePreset("alucard");
    expect(alucard.colors.bg).toBe("#FFFBEB");
    expect(alucard.colors["bg-secondary"]).toBe("#EFEDDC");
    expect(alucard.colors.text).toBe("#1F1F1F");
    expect(alucard.colors["text-muted"]).toBe("#6C664B");
    expect(alucard.colors.accent).toBe("#644AC9");
    expect(alucard.colors.selection).toBe("#CFCFDE");
    expect(alucard.syntax.keyword).toBe("#A3144D");
    expect(alucard.syntax.string).toBe("#846E15");
    expect(alucard.syntax.number).toBe("#A34D14");
    expect(alucard.syntax.comment).toBe("#6C664B");
    expect(alucard.syntax.function).toBe("#14710A");
    expect(alucard.syntax.variable).toBe("#644AC9");
    expect(alucard.syntax.type).toBe("#036A96");
  });

  it("validates theme IDs per mode and falls back to default for unknown IDs", () => {
    expect(isLightThemeId("alucard")).toBe(true);
    expect(isLightThemeId("dracula")).toBe(false);
    expect(isDarkThemeId("dracula")).toBe(true);
    expect(isDarkThemeId("alucard")).toBe(false);

    expect(getThemePreset("light", "dracula").id).toBe("default");
    expect(getThemePreset("dark", "alucard").id).toBe("default");
  });
});
