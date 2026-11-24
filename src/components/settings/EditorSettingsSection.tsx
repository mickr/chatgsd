import { useTheme } from "../../context/ThemeContext";
import {
  DARK_THEMES,
  LIGHT_THEMES,
  getDarkThemePreset,
  getLightThemePreset,
  type ThemePreset,
} from "../../lib/themes";
import { Button, CodeCopyButton, IconButton, Input, Select } from "../ui";
import { ColorPicker } from "../ui/ColorPicker";
import type {
  FontFamily,
  TextDirection,
  EditorWidth,
  ThemeColorKey,
} from "../../types/note";
import { CheckIcon, ChevronRightIcon, EyeIcon, MinusIcon, PlusIcon } from "../icons";
import { cn } from "../../lib/utils";

// Human-readable labels for theme color keys, grouped logically
const colorLabels: { key: ThemeColorKey; label: string; group: string }[] = [
  // Surfaces
  { key: "bg", label: "Background", group: "Surfaces" },
  { key: "bg-secondary", label: "Sidebar", group: "Surfaces" },
  { key: "bg-muted", label: "Hover & Subtle Fill", group: "Surfaces" },
  { key: "bg-emphasis", label: "Strong Fill", group: "Surfaces" },
  // Text & UI
  { key: "text", label: "Text", group: "Text & UI" },
  { key: "text-muted", label: "Secondary Text", group: "Text & UI" },
  { key: "accent", label: "Primary & Buttons", group: "Text & UI" },
  { key: "border", label: "Borders", group: "Text & UI" },
  { key: "selection", label: "Selection Highlight", group: "Text & UI" },
];

// Text direction options
const textDirectionOptions: { value: TextDirection; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "ltr", label: "LTR" },
  { value: "rtl", label: "RTL" },
];

// Page width options
const editorWidthOptions: { value: EditorWidth; label: string }[] = [
  { value: "narrow", label: "Narrow" },
  { value: "normal", label: "Normal" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
  { value: "custom", label: "Custom" },
];

// Font family options
const fontFamilyOptions: { value: FontFamily; label: string }[] = [
  { value: "system-sans", label: "Sans" },
  { value: "serif", label: "Serif" },
  { value: "monospace", label: "Mono" },
];

// Bold weight options (medium excluded for monospace)
const boldWeightOptions = [
  { value: 500, label: "Medium", excludeForMonospace: true },
  { value: 600, label: "Semibold", excludeForMonospace: false },
  { value: 700, label: "Bold", excludeForMonospace: false },
  { value: 800, label: "Extra Bold", excludeForMonospace: false },
];

export function AppearanceSettingsSection() {
  const {
    theme,
    resolvedTheme,
    lightTheme,
    darkTheme,
    setTheme,
    setLightTheme,
    setDarkTheme,
    editorFontSettings,
    setEditorFontSetting,
    resetEditorFontSettings,
    textDirection,
    setTextDirection,
    editorWidth,
    setEditorWidth,
    interfaceZoom,
    setInterfaceZoom,
    customEditorWidthPx,
    setCustomEditorWidthPx,
    customColorsLight,
    customColorsDark,
    setCustomColor,
    resetCustomColor,
    resetAllCustomColors,
  } = useTheme();

  const activeLightPreset = getLightThemePreset(lightTheme);
  const activeDarkPreset = getDarkThemePreset(darkTheme);

  // Validated numeric change handler
  const handleNumericChange = (
    field: "baseFontSize" | "lineHeight",
    value: string,
    min: number,
    max: number,
  ) => {
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(Math.max(parsed, min), max);
    setEditorFontSetting(field, clamped);
  };

  // Check if settings differ from defaults
  const hasCustomFonts =
    editorFontSettings.baseFontFamily !== "system-sans" ||
    editorFontSettings.baseFontSize !== 15 ||
    editorFontSettings.boldWeight !== 600 ||
    editorFontSettings.lineHeight !== 1.6 ||
    textDirection !== "auto" ||
    editorWidth !== "normal" ||
    Math.round(interfaceZoom * 100) !== 100;

  // Filter weight options based on font family
  const isMonospace = editorFontSettings.baseFontFamily === "monospace";
  const availableWeightOptions = boldWeightOptions.filter(
    (opt) => !isMonospace || !opt.excludeForMonospace,
  );

  // Handle font family change - bump up weight if needed
  const handleFontFamilyChange = (newFamily: FontFamily) => {
    setEditorFontSetting("baseFontFamily", newFamily);
    // If switching to monospace and current weight is medium, bump to semibold
    if (newFamily === "monospace" && editorFontSettings.boldWeight === 500) {
      setEditorFontSetting("boldWeight", 600);
    }
  };

  return (
    <div className="space-y-8 py-8">
      {/* Theme Section */}
      <section className="pb-2">
        <h2 className="text-xl font-medium mb-3">Theme</h2>
        <div className="flex gap-2 p-1 rounded-[10px] border border-border">
          {(["light", "dark", "system"] as const).map((mode) => (
            <Button
              key={mode}
              onClick={() => setTheme(mode)}
              variant={theme === mode ? "primary" : "ghost"}
              size="md"
              className="flex-1"
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </Button>
          ))}
        </div>
        {theme === "system" && (
          <p className="mt-2.5 text-sm text-text-muted">
            Follows system appearance (currently {resolvedTheme} —{" "}
            {resolvedTheme === "dark" ? activeDarkPreset.name : activeLightPreset.name})
          </p>
        )}

        {/* Independent Light & Dark Theme Pickers (mix and match) */}
        <div className="mt-5 space-y-5">
          <ThemePresetGrid
            title="Light theme"
            presets={LIGHT_THEMES}
            selectedId={lightTheme}
            isActive={resolvedTheme === "light"}
            isSystem={theme === "system"}
            onSelect={setLightTheme}
          />
          <ThemePresetGrid
            title="Dark theme"
            presets={DARK_THEMES}
            selectedId={darkTheme}
            isActive={resolvedTheme === "dark"}
            isSystem={theme === "system"}
            onSelect={setDarkTheme}
          />
        </div>

        {/* Customize Colors */}
        {theme === "system" ? (
          <div className="mt-5 space-y-2">
            <ColorsExpandable
              label={`Customize light colors (${activeLightPreset.name})`}
              mode="light"
              defaults={activeLightPreset.colors}
              customColors={customColorsLight}
              setCustomColor={setCustomColor}
              resetCustomColor={resetCustomColor}
              resetAllCustomColors={resetAllCustomColors}
            />
            <ColorsExpandable
              label={`Customize dark colors (${activeDarkPreset.name})`}
              mode="dark"
              defaults={activeDarkPreset.colors}
              customColors={customColorsDark}
              setCustomColor={setCustomColor}
              resetCustomColor={resetCustomColor}
              resetAllCustomColors={resetAllCustomColors}
            />
          </div>
        ) : (
          <ColorsExpandable
            label={`Customize colors (${resolvedTheme === "dark" ? activeDarkPreset.name : activeLightPreset.name})`}
            mode={resolvedTheme}
            defaults={
              resolvedTheme === "dark"
                ? activeDarkPreset.colors
                : activeLightPreset.colors
            }
            customColors={
              resolvedTheme === "dark" ? customColorsDark : customColorsLight
            }
            setCustomColor={setCustomColor}
            resetCustomColor={resetCustomColor}
            resetAllCustomColors={resetAllCustomColors}
            className="mt-5"
          />
        )}
      </section>

      {/* Divider */}
      <div className="border-t border-border border-dashed" />

      {/* Typography Section */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-xl font-medium">Typography</h2>
          {hasCustomFonts && (
            <Button onClick={resetEditorFontSettings} variant="ghost" size="sm">
              Reset to defaults
            </Button>
          )}
        </div>

        <div className="rounded-[10px] border border-border pl-4 py-3 pr-3 space-y-2">
          {/* Font Family */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-text font-medium">Font</label>
            <Select
              value={editorFontSettings.baseFontFamily}
              onChange={(e) =>
                handleFontFamilyChange(e.target.value as FontFamily)
              }
              className="w-40"
            >
              {fontFamilyOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          {/* Base Font Size */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-text font-medium">Size</label>
            <div className="relative w-40">
              <Input
                type="number"
                min="12"
                max="24"
                value={editorFontSettings.baseFontSize}
                onChange={(e) =>
                  handleNumericChange("baseFontSize", e.target.value, 12, 24)
                }
                className="w-full h-9 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          </div>

          {/* Bold Weight */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-text font-medium">Bold Weight</label>
            <Select
              value={editorFontSettings.boldWeight}
              onChange={(e) =>
                setEditorFontSetting("boldWeight", Number(e.target.value))
              }
              className="w-40"
            >
              {availableWeightOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          {/* Line Height */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-text font-medium">Line Height</label>
            <div className="relative w-40">
              <Input
                type="number"
                min="1.0"
                max="2.5"
                step="0.1"
                value={editorFontSettings.lineHeight}
                onChange={(e) =>
                  handleNumericChange("lineHeight", e.target.value, 1.0, 2.5)
                }
                className="w-full h-9 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          </div>

          {/* Text Direction */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-text font-medium">
              Text Direction
            </label>
            <Select
              value={textDirection}
              onChange={(e) =>
                setTextDirection(e.target.value as TextDirection)
              }
              className="w-40"
            >
              {textDirectionOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          {/* Page Width */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-text font-medium">Page Width</label>
            <Select
              value={editorWidth}
              onChange={(e) => setEditorWidth(e.target.value as EditorWidth)}
              className="w-40"
            >
              {editorWidthOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>
          {editorWidth === "custom" && (
            <div className="flex items-center justify-between">
              <label className="text-sm text-text font-medium">
                Custom Width
              </label>
              <div className="relative w-40 flex items-center gap-2">
                <Input
                  type="number"
                  min="480"
                  max="3840"
                  step="10"
                  value={customEditorWidthPx}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value, 10);
                    if (Number.isFinite(parsed)) {
                      setCustomEditorWidthPx(
                        Math.min(Math.max(parsed, 480), 3840),
                      );
                    }
                  }}
                  className="w-full h-9 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="text-sm text-text-muted">px</span>
              </div>
            </div>
          )}

          {/* Interface Zoom */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-text font-medium">
              Interface Zoom
            </label>
            <div className="flex items-center gap-1 w-40">
              <IconButton
                variant="outline"
                size="md"
                onClick={() => setInterfaceZoom((prev) => prev - 0.05)}
                disabled={interfaceZoom <= 0.7}
                title="Zoom out"
              >
                <MinusIcon className="w-4 h-4" />
              </IconButton>
              <span className="text-sm font-medium tabular-nums flex-1 text-center">
                {Math.round(interfaceZoom * 100)}%
              </span>
              <IconButton
                variant="outline"
                size="md"
                onClick={() => setInterfaceZoom((prev) => prev + 0.05)}
                disabled={interfaceZoom >= 1.5}
                title="Zoom in"
              >
                <PlusIcon className="w-4 h-4" />
              </IconButton>
            </div>
          </div>
        </div>

        {/* Preview */}
        <div className="mt-3 relative">
          <div className="absolute top-3 left-4 flex items-center text-sm font-medium text-text-muted/70 gap-1">
            <EyeIcon className="w-4.5 h-4.5 stroke-[1.5]" />
            <span>Preview</span>
          </div>
          <div className="border border-border rounded-[10px] bg-bg p-6 pt-20 max-h-160 overflow-hidden rounded-t-lg">
            <div
              className="prose prose-lg dark:prose-invert max-w-xl mx-auto"
              dir={textDirection}
              style={{
                fontFamily:
                  editorFontSettings.baseFontFamily === "system-sans"
                    ? "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
                    : editorFontSettings.baseFontFamily === "serif"
                      ? "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif"
                      : "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
                fontSize: `${editorFontSettings.baseFontSize}px`,
              }}
            >
              <h1>Kibble Maximization Protocol</h1>
              <p>
                A comprehensive strategy document for getting your humans to
                increase daily food portions.{" "}
                <strong>Time-tested methods</strong> that actually work.
              </p>

              <h2>Primary Techniques</h2>
              <ul>
                <li>
                  <strong>The Sad Eyes Method</strong> - Sit near food bowl,
                  stare longingly
                </li>
                <li>
                  <strong>Strategic Meowing</strong> - Begin at 5 AM for maximum
                  effectiveness
                </li>
                <li>
                  <strong>Bowl Inspection</strong> - Loudly inspect empty bowl,
                  then stare at human
                </li>
                <li>
                  <strong>The Figure Eight</strong> - Weave between their legs
                  while they cook
                </li>
              </ul>

              <h2>Advanced Protocol</h2>
              <p>
                For optimal results, combine multiple techniques. The most
                successful combination involves the Sad Eyes Method followed
                immediately by Strategic Meowing.
              </p>

              <div className="relative my-1">
                <div className="absolute top-2 right-2 z-10">
                  <CodeCopyButton
                    text={`function acquireFood() {
  while (bowl.isEmpty()) {
    meow();
    rubAgainstLegs();
    if (human.isInKitchen) {
      stareIntently();
    }
  }
}`}
                  />
                </div>
                <pre className="pt-10">
                  <code>
                    {`function acquireFood() {
  while (bowl.isEmpty()) {
    meow();
    rubAgainstLegs();
    if (human.isInKitchen) {
      stareIntently();
    }
  }
}`}
                  </code>
                </pre>
              </div>

              <h2>Common Mistakes to Avoid</h2>
              <ol>
                <li>Never accept the first "no" - persistence is key</li>
                <li>
                  Maintain consistency in meal times (your schedule, not theirs)
                </li>
                <li>Don't forget to knock things off counters periodically</li>
              </ol>

              <p>
                Remember: <em>humans are trainable</em>. With dedication and the
                right approach, you can increase portions by up to 40% within
                the first month.
              </p>
            </div>
          </div>
          {/* Fade overlay - content to muted background */}
          <div className="absolute bottom-0 left-0 right-0 h-40 bg-linear-to-t from-bg to-transparent pointer-events-none" />
        </div>
      </section>
    </div>
  );
}

// Visual grid of theme presets for either Light or Dark mode
function ThemePresetGrid<Id extends string>({
  title,
  presets,
  selectedId,
  isActive,
  isSystem,
  onSelect,
}: {
  title: string;
  presets: readonly ThemePreset<Id>[];
  selectedId: Id;
  isActive: boolean;
  isSystem: boolean;
  onSelect: (id: Id) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-text">{title}</span>
        {isActive && (
          <span className="text-2xs font-medium px-2 py-0.5 rounded-full bg-bg-muted text-text-muted">
            {isSystem ? "Active · System" : "Active"}
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {presets.map((preset) => {
          const isSelected = preset.id === selectedId;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onSelect(preset.id)}
              aria-pressed={isSelected}
              className={cn(
                "group text-left rounded-[10px] border p-2 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
                isSelected
                  ? "border-accent ring-1 ring-accent bg-bg-muted/40"
                  : "border-border hover:border-text-muted/50 bg-bg",
              )}
            >
              {/* Miniature app preview rendered with the preset's actual colors */}
              <div
                className="h-14 rounded-md overflow-hidden flex border"
                style={{
                  backgroundColor: preset.colors.bg,
                  borderColor: preset.colors.border,
                }}
              >
                {/* Mini sidebar */}
                <div
                  className="w-1/4 p-1.5 flex flex-col gap-1 border-r"
                  style={{
                    backgroundColor: preset.colors["bg-secondary"],
                    borderColor: preset.colors.border,
                  }}
                >
                  <div
                    className="h-1 w-full rounded-full opacity-70"
                    style={{ backgroundColor: preset.colors["text-muted"] }}
                  />
                  <div
                    className="h-1 w-3/4 rounded-full opacity-45"
                    style={{ backgroundColor: preset.colors["text-muted"] }}
                  />
                  <div
                    className="h-1 w-4/5 rounded-full opacity-45"
                    style={{ backgroundColor: preset.colors["text-muted"] }}
                  />
                </div>
                {/* Mini editor */}
                <div className="flex-1 p-2 flex flex-col justify-between">
                  <div className="space-y-1">
                    <div
                      className="h-1.5 w-3/5 rounded-full"
                      style={{ backgroundColor: preset.colors.text }}
                    />
                    <div
                      className="h-1 w-5/6 rounded-full opacity-60"
                      style={{ backgroundColor: preset.colors["text-muted"] }}
                    />
                    <div
                      className="h-1 w-2/3 rounded-full opacity-45"
                      style={{ backgroundColor: preset.colors["text-muted"] }}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div
                      className="h-1.5 w-6 rounded-sm"
                      style={{ backgroundColor: preset.colors.accent }}
                    />
                    <div className="flex items-center gap-1">
                      {preset.previewAccents.map((swatch, idx) => (
                        <span
                          key={idx}
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: swatch }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-2 px-0.5 flex items-center justify-between gap-1">
                <span className="text-xs font-medium text-text truncate">
                  {preset.name}
                </span>
                {isSelected && (
                  <CheckIcon className="w-3.5 h-3.5 shrink-0 text-accent" />
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Expandable subsection for customizing colors for a single theme mode
function ColorsExpandable({
  label,
  mode,
  defaults,
  customColors,
  setCustomColor,
  resetCustomColor,
  resetAllCustomColors,
  className,
}: {
  label: string;
  mode: "light" | "dark";
  defaults: Record<ThemeColorKey, string>;
  customColors: Partial<Record<ThemeColorKey, string>>;
  setCustomColor: (
    mode: "light" | "dark",
    key: ThemeColorKey,
    value: string,
  ) => void;
  resetCustomColor: (mode: "light" | "dark", key: ThemeColorKey) => void;
  resetAllCustomColors: (mode: "light" | "dark") => void;
  className?: string;
}) {
  const hasAnyCustom = Object.keys(customColors).length > 0;

  return (
    <details className={cn("text-sm", className)}>
      <summary className="cursor-pointer text-text-muted hover:text-text select-none flex items-center gap-1 font-medium">
        <ChevronRightIcon className="w-3.5 h-3.5 stroke-2 transition-transform [[open]>&]:rotate-90" />
        {label}
        {hasAnyCustom && (
          <Button
            onClick={(e) => {
              e.preventDefault();
              resetAllCustomColors(mode);
            }}
            variant="ghost"
            size="sm"
            className="ml-auto"
          >
            Reset all
          </Button>
        )}
      </summary>
      <div className="mt-2 rounded-[10px] border border-border pl-4 py-3 pr-3 space-y-1.5">
        {(() => {
          let lastGroup = "";
          return colorLabels.map(({ key, label: colorLabel, group }) => {
            const showGroup = group !== lastGroup;
            lastGroup = group;
            return (
              <div key={key}>
                {showGroup && (
                  <div
                    className={`text-base text-text-muted font-medium ${key !== colorLabels[0].key ? "mt-6" : ""} mb-2.5`}
                  >
                    {group}
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <label className="text-sm text-text font-medium">
                    {colorLabel}
                  </label>
                  <ColorPicker
                    color={customColors[key] ?? defaults[key]}
                    defaultColor={defaults[key]}
                    onChange={(value) => setCustomColor(mode, key, value)}
                    onReset={() => resetCustomColor(mode, key)}
                  />
                </div>
              </div>
            );
          });
        })()}
      </div>
    </details>
  );
}
