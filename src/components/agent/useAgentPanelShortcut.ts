import { useEffect } from "react";

/**
 * ⌘J and ⌘⌥B toggle the agent panel. ⌘⌥→ moves focus into it and ⌘⌥← back to
 * the note, so focus only crosses between them when the user asks. ⌘⌥Enter asks
 * about the current selection or cursor, so it only works from the note.
 */
export function useAgentPanelShortcut(
  enabled: boolean,
  toggle: () => void,
  focusPanel: () => void,
  focusNote: () => void,
): void {
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return;
      // Option changes event.key on macOS, so match physical keys with it held.
      const withOption: Record<string, (() => void) | undefined> = {
        KeyB: toggle,
        ArrowRight: focusPanel,
        ArrowLeft: focusNote,
      };
      const fromNote = event.code === "Enter" && !event.repeat && !event.isComposing &&
        !!document.activeElement?.closest("[data-writing-workspace]");
      const action = event.altKey
        ? fromNote ? focusPanel : withOption[event.code]
        : event.key.toLowerCase() === "j" ? toggle : undefined;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [enabled, toggle, focusPanel, focusNote]);
}
