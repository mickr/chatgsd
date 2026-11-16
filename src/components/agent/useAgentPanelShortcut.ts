import { useEffect } from "react";

export function useAgentPanelShortcut(enabled: boolean, toggle: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        !(event.altKey
          ? event.code === "KeyB"
          : event.key.toLowerCase() === "j")
      ) return;
      // Option changes event.key on macOS, so match its physical B key.
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [enabled, toggle]);
}
