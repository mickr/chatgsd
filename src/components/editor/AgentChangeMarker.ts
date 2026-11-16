import { mountChangeDiff } from "../agent/ChangeDiff";

export interface AgentLineChange {
  id: string;
  runId: string | null;
  from: number;
  to: number;
  before: string;
  after: string;
}

const disposers = new WeakMap<Node, () => void>();

export function changeMarker(changes: AgentLineChange[]): HTMLElement {
  const change = changes[0];
  const host = document.createElement("span");
  host.className = "agent-line-marker not-prose";
  host.contentEditable = "false";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "agent-line-marker-button";
  button.setAttribute("aria-label", "Show agent change");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", `change-${change.id}`);
  const popup = document.createElement("div");
  popup.id = `change-${change.id}`;
  popup.className = "agent-line-diff-popover not-prose";
  popup.popover = "auto";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Agent change, before and after");
  const heading = document.createElement("div");
  heading.className = "agent-line-diff-heading";
  heading.textContent = "Agent change · Latest editing turn";
  popup.append(heading);
  host.append(button, popup);
  let visible = false;
  let disposeDiff: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  popup.addEventListener("toggle", (event) => {
    visible = (event as ToggleEvent).newState === "open";
    button.setAttribute("aria-expanded", String(visible));
  });
  const close = () => {
    clearTimeout(timer);
    if (visible && popup.isConnected) popup.hidePopover();
    visible = false;
    button.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    clearTimeout(timer);
    if (!host.isConnected) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(520, window.innerWidth - 24);
    popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(12, Math.min(rect.right + 8, window.innerWidth - width - 12))}px`;
    popup.style.top = `${Math.max(12, Math.min(rect.top, window.innerHeight - 300))}px`;
    if (!visible) popup.showPopover();
    visible = true;
    button.setAttribute("aria-expanded", "true");
    if (!disposeDiff) {
      const cleanups = changes.map((entry) => {
        const content = document.createElement("div");
        content.className = "agent-change-diff";
        popup.append(content);
        return mountChangeDiff(content, entry.before, entry.after, "Agent change");
      });
      disposeDiff = () => { for (const cleanup of cleanups) cleanup(); };
    }
  };
  host.onmouseenter = open;
  host.onmouseleave = () => {
    timer = setTimeout(() => { if (!host.contains(document.activeElement)) close(); }, 120);
  };
  button.onfocus = open;
  button.onmousedown = (event) => event.preventDefault();
  button.onclick = open;
  host.addEventListener("focusout", () => {
    queueMicrotask(() => { if (!host.contains(document.activeElement)) close(); });
  });
  host.onkeydown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
  };
  disposers.set(host, () => { clearTimeout(timer); close(); disposeDiff?.(); });
  return host;
}

export function destroyChangeMarker(node: Node) {
  disposers.get(node)?.();
  disposers.delete(node);
}
