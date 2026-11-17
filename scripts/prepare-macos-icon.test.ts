import { expect, it } from "vitest";
import { validateAppearances } from "./prepare-macos-icon.mjs";

const rendition = (appearance: string, name = "AppIcon", type = "IconImageStack") => ({
  Name: name, AssetType: type, Appearance: appearance,
});

it("requires both native appearances before an icon reaches the release", () => {
  const light = rendition("NSAppearanceNameAqua");
  const dark = rendition("NSAppearanceNameDarkAqua");
  expect(() => validateAppearances([light, dark])).not.toThrow();
  expect(() => validateAppearances([light])).toThrow("NSAppearanceNameDarkAqua");
  expect(() => validateAppearances([dark])).toThrow("NSAppearanceNameAqua");
});

it("does not mistake unrelated images or groups for an adaptive app icon", () => {
  expect(() => validateAppearances([
    rendition("NSAppearanceNameAqua", "OtherIcon"),
    rendition("NSAppearanceNameDarkAqua", "OtherIcon"),
  ])).toThrow("NSAppearanceNameAqua");
  expect(() => validateAppearances([
    rendition("NSAppearanceNameAqua", "AppIcon", "IconGroup"),
    rendition("NSAppearanceNameDarkAqua", "AppIcon", "IconGroup"),
  ])).toThrow("NSAppearanceNameAqua");
});
