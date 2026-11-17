// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { AgentChanges, setChangeMeta } from "./AgentChanges";
import { AgentFollow } from "./AgentFollow";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let editor: Editor;
let root: Root;
let host: HTMLDivElement;
let pane: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let scroll: Mock;
let caretTop: number;

beforeEach(() => {
  host = document.createElement("div");
  pane = document.createElement("div");
  document.body.append(host, pane);
  editor = new Editor({ element: pane, extensions: [StarterKit, AgentChanges], content: "<p>Your paragraph.</p><p>Agent paragraph.</p>" });
  editor.commands.setTextSelection(3);
  frames = new Map();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  caretTop = 900;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("agent-presence-caret") ? new DOMRect(0, caretTop, 2, 20) : new DOMRect(0, 0, 600, 400);
  });
  scroll = vi.fn();
  pane.scrollTo = scroll;
  root = createRoot(host);
  act(() => root.render(<AgentFollow editor={editor} containerRef={{ current: pane }} />));
});
afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  host.remove();
  pane.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function presence(position = 20) {
  act(() => editor.view.dispatch(setChangeMeta(editor.state.tr, { presence: { agent: { from: position, to: position } } })));
}
function flush() {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(0));
}
function toggle() { act(() => host.querySelector("button")!.click()); }

it("follows offscreen agent work only after opting in, without moving the user's selection", () => {
  presence();
  flush();
  expect(scroll).not.toHaveBeenCalled();
  toggle();
  flush();
  expect(scroll).toHaveBeenCalledWith({ top: 700, behavior: "instant" });
  expect(editor.state.selection.from).toBe(3);
  scroll.mockClear();
  caretTop = 150;
  presence(22);
  flush();
  expect(scroll).not.toHaveBeenCalled();
  pane.dispatchEvent(new Event("scroll"));
  expect(host.querySelector("button")!.getAttribute("aria-pressed")).toBe("true");
});

it.each(["wheel", "touchstart", "pointerdown", "keydown", "beforeinput"])("pauses on %s and cancels a queued follow until rejoined", event => {
  presence();
  toggle();
  act(() => pane.dispatchEvent(new Event(event)));
  flush();
  presence(22);
  flush();
  expect(scroll).not.toHaveBeenCalled();
  expect(host.querySelector("button")!.getAttribute("aria-pressed")).toBe("false");
  toggle();
  flush();
  expect(scroll).toHaveBeenCalledOnce();
});

it("clears following when the document's presence is cleared", () => {
  presence();
  toggle();
  act(() => editor.view.dispatch(setChangeMeta(editor.state.tr, { clear: true })));
  flush();
  expect(scroll).not.toHaveBeenCalled();
  expect(host.querySelector("button")).toBeNull();
  presence();
  flush();
  expect(host.querySelector("button")!.getAttribute("aria-pressed")).toBe("false");
});
