import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BoltIcon,
  ChatGPTIcon,
  CheckIcon,
  ChevronDownIcon,
  SparkleIcon,
} from "../icons";
import { Tooltip } from "../ui";
import { isAntigravityModel, type ModelInfo } from "../../services/agent";
import "./ModelPicker.css";

const EFFORT_LABELS: Record<string, string> = {
  none: "Off",
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "Extra",
  max: "Max",
  ultra: "Ultra",
};

const EFFORT_FULL_LABELS: Record<string, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
  ultra: "Ultra",
};

const POPOVER_WIDTH = 280;
const CLOSE_MS = 95;
const METER_HEIGHTS = [4, 6, 8, 10];

function shortEffortLabel(effort: string) {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

function fullEffortLabel(effort: string) {
  return EFFORT_FULL_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

function ThinkingMeter({ efforts, current }: { efforts: string[]; current: string }) {
  const index = Math.max(0, efforts.indexOf(current));
  const total = Math.max(1, efforts.length);
  const filledCount =
    current === "none"
      ? 0
      : Math.max(1, Math.round(((index + 1) / total) * METER_HEIGHTS.length));
  return (
    <span className="thinking-meter" aria-hidden="true">
      {METER_HEIGHTS.map((height, bar) => (
        <span
          key={height}
          className="thinking-meter-bar"
          style={{ height }}
          data-filled={bar < filledCount ? "true" : undefined}
        />
      ))}
    </span>
  );
}

interface PopoverSnapshot {
  model: string;
  tab: "chatgpt" | "antigravity";
  effort: string;
  efforts: string[];
  priorityMode: boolean;
  supportsPriority: boolean;
  priorityDescription: string | null;
}

export interface ModelPickerProps {
  ready: boolean;
  disabled: boolean;
  modelsLoading: boolean;
  model: string;
  models: ModelInfo[];
  onSelectModel: (modelId: string) => void;
  effort: string;
  efforts: string[];
  onSelectEffort?: (effort: string) => void;
  priorityMode: boolean;
  supportsPriority: boolean;
  priorityDescription: string | null;
  onTogglePriority?: (enabled: boolean) => void;
}

export function ModelPicker({
  ready,
  disabled,
  modelsLoading,
  model,
  models,
  onSelectModel,
  effort,
  efforts,
  onSelectEffort,
  priorityMode,
  supportsPriority,
  priorityDescription,
  onTogglePriority,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [closingSnapshot, setClosingSnapshot] = useState<PopoverSnapshot | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const usingAntigravity = isAntigravityModel(model);
  const chatgptModels = useMemo(
    () => models.filter((item) => !isAntigravityModel(item.id)),
    [models],
  );
  const antigravityModels = useMemo(
    () => models.filter((item) => isAntigravityModel(item.id)),
    [models],
  );
  const hasBothProviders = chatgptModels.length > 0 && antigravityModels.length > 0;
  const [tab, setTab] = useState<"chatgpt" | "antigravity">(
    usingAntigravity ? "antigravity" : "chatgpt",
  );

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const closeMenu = useCallback(
    (snapshot?: PopoverSnapshot) => {
      clearCloseTimer();
      if (snapshot) setClosingSnapshot(snapshot);
      setOpen(false);
      closeTimer.current = window.setTimeout(() => {
        setMounted(false);
        setClosingSnapshot(null);
        closeTimer.current = null;
      }, CLOSE_MS);
    },
    [clearCloseTimer],
  );

  const openMenu = useCallback(() => {
    clearCloseTimer();
    setClosingSnapshot(null);
    setTab(usingAntigravity ? "antigravity" : "chatgpt");
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const margin = 10;
      const maxLeft = Math.max(margin, window.innerWidth - POPOVER_WIDTH - margin);
      const left = Math.min(Math.max(margin, rect.left), maxLeft);
      setCoords({ top: Math.round(rect.bottom + 6), left: Math.round(left) });
    }
    setMounted(true);
    // Flip `open` on the next frame so the CSS enter transition plays cleanly once.
    requestAnimationFrame(() => setOpen(true));
  }, [clearCloseTimer, usingAntigravity]);

  const toggleMenu = useCallback(() => {
    if (open) closeMenu();
    else openMenu();
  }, [open, closeMenu, openMenu]);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  // Close cleanly when clicking outside, pressing Escape, or resizing the window.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (
        popoverRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
      }
    };
    const onResize = () => closeMenu();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, closeMenu]);

  // Close if disabled mid-open (e.g. a run starts).
  useEffect(() => {
    if (disabled && open) closeMenu();
  }, [disabled, open, closeMenu]);

  const activeModel = models.find((item) => item.id === model) ?? null;

  if (!ready) {
    return (
      <div className="model-picker-root">
        <span className="text-sm font-medium pl-1 py-0.5 text-text">
          {usingAntigravity ? "Antigravity" : "ChatGPT"}
        </span>
      </div>
    );
  }

  const displayName =
    activeModel?.label ??
    (modelsLoading ? "Loading models…" : usingAntigravity ? "Antigravity" : "ChatGPT");

  const priorityTooltip = priorityMode
    ? `Priority on${priorityDescription ? ` · ${priorityDescription}` : ""}`
    : `Priority mode${priorityDescription ? ` · ${priorityDescription}` : " (faster speed)"}`;

  // While fading out, render the frozen snapshot so the closing popover never
  // changes height or flashes its sections as the newly selected model loads.
  const view: PopoverSnapshot = closingSnapshot ?? {
    model,
    tab,
    effort,
    efforts,
    priorityMode,
    supportsPriority,
    priorityDescription,
  };

  const visibleModels = hasBothProviders
    ? view.tab === "antigravity"
      ? antigravityModels
      : chatgptModels
    : models;

  const handleSelectModel = (modelId: string) => {
    closeMenu({
      model: modelId,
      tab,
      effort,
      efforts,
      priorityMode,
      supportsPriority,
      priorityDescription,
    });
    if (modelId !== model) {
      onSelectModel(modelId);
    }
  };

  return (
    <div className="model-picker-root">
      <div className="model-picker-header-row">
        <button
          ref={triggerRef}
          type="button"
          aria-label="Agent model"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-state={open ? "open" : "closed"}
          disabled={disabled || modelsLoading || !models.length}
          onClick={toggleMenu}
          className="model-picker-trigger"
        >
          <span className="model-picker-trigger-body">
            <span className="model-picker-title-line">
              <span
                className="model-picker-provider-glyph"
                data-provider={usingAntigravity ? "antigravity" : "chatgpt"}
                aria-hidden="true"
              >
                {usingAntigravity ? (
                  <SparkleIcon className="w-3.5 h-3.5" />
                ) : (
                  <ChatGPTIcon className="w-3.5 h-3.5" />
                )}
              </span>
              <span className="model-picker-name">{displayName}</span>
            </span>
            {efforts.length > 1 && effort && (
              <span className="model-picker-meta-line">
                <span className="model-picker-meta-item">
                  <ThinkingMeter efforts={efforts} current={effort} />
                  <span>{fullEffortLabel(effort)}</span>
                </span>
              </span>
            )}
          </span>
          <ChevronDownIcon className="model-picker-chevron w-3.5 h-3.5" />
        </button>

        {supportsPriority && (
          <Tooltip content={priorityTooltip}>
            <button
              type="button"
              aria-label="Priority mode"
              aria-pressed={priorityMode}
              data-active={priorityMode ? "true" : undefined}
              disabled={disabled || modelsLoading}
              onClick={() => onTogglePriority?.(!priorityMode)}
              className="model-picker-quick-bolt"
            >
              <BoltIcon className="w-3.5 h-3.5" filled={priorityMode} />
            </button>
          </Tooltip>
        )}
      </div>

      {mounted &&
        coords &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Model settings"
            data-open={open ? "true" : "false"}
            className="model-picker-popover"
            style={{ top: coords.top, left: coords.left, width: POPOVER_WIDTH }}
          >
            {hasBothProviders && (
              <div className="model-picker-tabs" role="tablist" aria-label="Provider">
                <button
                  type="button"
                  role="tab"
                  aria-selected={view.tab === "chatgpt"}
                  data-provider="chatgpt"
                  data-active={view.tab === "chatgpt" ? "true" : undefined}
                  className="model-picker-tab"
                  onClick={() => setTab("chatgpt")}
                >
                  <ChatGPTIcon className="w-3.5 h-3.5" />
                  <span>ChatGPT</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view.tab === "antigravity"}
                  data-provider="antigravity"
                  data-active={view.tab === "antigravity" ? "true" : undefined}
                  className="model-picker-tab"
                  onClick={() => setTab("antigravity")}
                >
                  <SparkleIcon className="w-3.5 h-3.5" />
                  <span>Antigravity</span>
                </button>
              </div>
            )}

            <div className="model-picker-list" role="listbox" aria-label="Models">
              {visibleModels.map((entry) => {
                const selected = entry.id === view.model;
                const fast = entry.serviceTiers?.some((tier) => tier.id === "priority");
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className="model-picker-item"
                    data-selected={selected ? "true" : undefined}
                    onClick={() => handleSelectModel(entry.id)}
                  >
                    <span className="model-picker-item-label">{entry.label}</span>
                    {fast && (
                      <BoltIcon
                        className="model-picker-item-bolt w-3 h-3"
                        filled={selected && view.priorityMode}
                      />
                    )}
                    <CheckIcon className="model-picker-item-check w-3.5 h-3.5" />
                  </button>
                );
              })}
            </div>

            {view.efforts.length > 1 && (
              <div className="model-picker-section">
                <div className="model-picker-section-head">
                  <span>Thinking</span>
                  <span className="model-picker-section-value">
                    <ThinkingMeter efforts={view.efforts} current={view.effort} />
                    <span>{fullEffortLabel(view.effort)}</span>
                  </span>
                </div>
                <div
                  className="model-picker-effort-track"
                  role="radiogroup"
                  aria-label="Thinking level"
                >
                  {view.efforts.map((level) => {
                    const active = level === view.effort;
                    return (
                      <button
                        key={level}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        data-active={active ? "true" : undefined}
                        className="model-picker-effort-btn"
                        onClick={() => onSelectEffort?.(level)}
                      >
                        {shortEffortLabel(level)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {view.supportsPriority && (
              <div className="model-picker-section">
                <button
                  type="button"
                  role="switch"
                  aria-checked={view.priorityMode}
                  data-active={view.priorityMode ? "true" : undefined}
                  className="model-picker-priority-row"
                  onClick={() => onTogglePriority?.(!view.priorityMode)}
                >
                  <span className="model-picker-priority-badge" aria-hidden="true">
                    <BoltIcon className="w-3.5 h-3.5" filled={view.priorityMode} />
                  </span>
                  <span className="model-picker-priority-copy">
                    <span className="model-picker-priority-title">Priority</span>
                    <span className="model-picker-priority-desc">
                      {view.priorityDescription || "Faster responses"}
                    </span>
                  </span>
                  <span className="model-picker-switch" aria-hidden="true">
                    <span className="model-picker-switch-thumb" />
                  </span>
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
