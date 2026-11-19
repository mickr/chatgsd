const FLASH = "agent-transcript-flash";
const FLASH_MS = 1600;

/**
 * Scrolls the panel's conversation to one of its items and flashes it, for a
 * map step that came from that item. False when it isn't in the conversation
 * on screen, such as an older conversation's message.
 */
export function showTranscriptItem(itemId: string | undefined): boolean {
  if (!itemId) return false;
  const wrapper = document.querySelector(`.agent-panel [data-transcript-item="${CSS.escape(itemId)}"]`);
  // The wrapper takes no box of its own; its message does.
  const target = wrapper?.firstElementChild;
  if (!(target instanceof HTMLElement)) return false;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  target.classList.remove(FLASH);
  void target.offsetWidth;
  target.classList.add(FLASH);
  setTimeout(() => target.classList.remove(FLASH), FLASH_MS);
  return true;
}
