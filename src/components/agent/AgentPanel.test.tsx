// @vitest-environment jsdom
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentChanges } from "../editor/AgentChanges";
import { TooltipProvider } from "../ui";
import { AgentPanel } from "./AgentPanel";
import { useAgentPanelShortcut } from "./useAgentPanelShortcut";
import type * as AgentContext from "../../context/AgentContext";

const state = vi.hoisted(() => ({ agent: {} as Record<string, unknown> }));
vi.mock("../../context/AgentContext", async (original) => ({
  ...await original<typeof AgentContext>(),
  useAgent: () => state.agent,
}));
vi.mock("../../context/NotesContext", () => ({
  useNotes: () => ({ currentNote: { id: "note", title: "Note" }, selectNote: vi.fn() }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let editor: Editor;

function Workspace() {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(value => !value), []);
  useAgentPanelShortcut(true, toggle);
  return <TooltipProvider>
    <button onClick={toggle}>Toggle agent</button>
    <AgentPanel visible={open} />
  </TooltipProvider>;
}

beforeEach(() => {
  vi.useFakeTimers();
  const editorElement = document.body.appendChild(document.createElement("div"));
  editor = new Editor({ element: editorElement, extensions: [StarterKit, AgentChanges], content: "<p>A note that must not become a quote.</p>" });
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  state.agent = {
    editor, width: 360, focusComposer: 0,
    status: { status: "ready", account: null },
    statusLoading: false, modelsLoading: false,
    model: "model", models: [{ id: "model", label: "Model" }],
    history: [], conversation: { items: [], runId: null },
  };
  act(() => root.render(<Workspace />));
});

afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function nextFrame() {
  act(() => vi.advanceTimersByTime(20));
}

it.each(["metaKey", "ctrlKey"] as const)("opens from the editor with %s and focuses chat without changing the note", (modifier) => {
  act(() => {
    editor.view.focus();
    editor.commands.setTextSelection({ from: 1, to: 7 });
  });
  const before = editor.getJSON();
  const pressToggle = (target: Element) => act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", {
      key: "∫", code: "KeyB", keyCode: 66, [modifier]: true, altKey: true,
      bubbles: true, cancelable: true,
    }));
  });
  pressToggle(editor.view.dom);
  nextFrame();
  const input = container.querySelector("textarea")!;
  expect(container.querySelector("aside")!.getAttribute("aria-hidden")).toBe("false");
  expect(document.activeElement).toBe(input);
  expect(editor.getJSON()).toEqual(before);
  expect(editor.isActive("blockquote")).toBe(false);

  pressToggle(input);
  nextFrame();
  expect(container.querySelector("aside")!.getAttribute("aria-hidden")).toBe("true");
  expect(editor.getJSON()).toEqual(before);
});

it("leaves Shift+Ctrl+B to the editor's blockquote shortcut", () => {
  // jsdom has no layout geometry for ProseMirror's scroll-to-selection.
  editor.setOptions({ editorProps: { handleScrollToSelection: () => true } });
  act(() => {
    editor.view.focus();
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
      key: "B", code: "KeyB", keyCode: 66, ctrlKey: true, shiftKey: true,
      bubbles: true, cancelable: true,
    }));
  });
  nextFrame();
  expect(container.querySelector("aside")!.getAttribute("aria-hidden")).toBe("true");
  expect(editor.isActive("blockquote")).toBe(true);
});

it("focuses chat after toolbar focus restoration and when reopened", () => {
  const button = container.querySelector("button")!;
  act(() => button.click());
  act(() => editor.view.focus());
  nextFrame();
  expect(document.activeElement).toBe(container.querySelector("textarea"));
  act(() => button.click());
  nextFrame();
  act(() => editor.view.focus());
  act(() => button.click());
  nextFrame();
  expect(document.activeElement).toBe(container.querySelector("textarea"));
});

it("does not steal editor focus when a pending send finishes", async () => {
  let finishSend!: (sent: boolean) => void;
  state.agent.send = vi.fn(() => new Promise<boolean>(resolve => { finishSend = resolve; }));
  act(() => container.querySelector("button")!.click());
  nextFrame();
  const input = container.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Help with this note");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
  expect(state.agent.send).toHaveBeenCalledWith("Help with this note");
  expect(input.disabled).toBe(true);
  act(() => editor.view.focus());
  await act(async () => { finishSend(true); });
  nextFrame();
  expect(input.disabled).toBe(false);
  expect(document.activeElement).toBe(editor.view.dom);
});
