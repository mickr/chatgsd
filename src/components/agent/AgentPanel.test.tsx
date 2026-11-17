// @vitest-environment jsdom
import { act, useCallback, useRef, useState } from "react";
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
  const [focusMode, setFocusMode] = useState(false);
  const [request, setRequest] = useState(0);
  const pending = useRef(false);
  state.agent.composerFocusRequest = request;
  state.agent.takeComposerFocus = useCallback(() => {
    const taken = pending.current;
    pending.current = false;
    return taken;
  }, []);
  const focusPanel = useCallback(() => {
    pending.current = true;
    setOpen(true);
    setRequest(value => value + 1);
  }, []);
  const focusNote = useCallback(() => {
    pending.current = false;
    editor.view.focus();
  }, []);
  const toggle = useCallback(() => {
    if (open) setOpen(false);
    else focusPanel();
  }, [open, focusPanel]);
  useAgentPanelShortcut(true, toggle, focusPanel, focusNote);
  return <TooltipProvider>
    <button onClick={toggle}>Toggle agent</button>
    <button onClick={() => setFocusMode(value => !value)}>Toggle focus mode</button>
    <AgentPanel visible={open && !focusMode} />
  </TooltipProvider>;
}

beforeEach(() => {
  vi.useFakeTimers();
  const editorElement = document.body.appendChild(document.createElement("div"));
  editor = new Editor({ element: editorElement, extensions: [StarterKit, AgentChanges], content: "<p>A note that must not become a quote.</p>" });
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  state.agent = {
    editor, width: 360, composerFocusRequest: 0,
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
  act(() => editor.view.focus());
  await act(async () => { finishSend(true); });
  nextFrame();
  expect(document.activeElement).toBe(editor.view.dom);
});

it("moves focus to chat with Cmd+Option+→ and back with Cmd+Option+← without closing the panel", () => {
  const press = (target: Element, code: string) => act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", {
      key: code, code, metaKey: true, altKey: true, bubbles: true, cancelable: true,
    }));
  });
  act(() => {
    editor.view.focus();
    editor.commands.setTextSelection(5);
  });
  const before = editor.getJSON();
  press(editor.view.dom, "ArrowRight");
  nextFrame();
  const input = container.querySelector("textarea")!;
  const panel = container.querySelector("aside")!;
  expect(panel.getAttribute("aria-hidden")).toBe("false");
  expect(document.activeElement).toBe(input);

  press(input, "ArrowLeft");
  nextFrame();
  expect(document.activeElement).toBe(editor.view.dom);
  expect(panel.getAttribute("aria-hidden")).toBe("false");
  expect(editor.state.selection.from).toBe(5);
  expect(editor.getJSON()).toEqual(before);

  press(editor.view.dom, "ArrowRight");
  nextFrame();
  expect(document.activeElement).toBe(input);
  expect(panel.getAttribute("aria-hidden")).toBe("false");
});

it("focuses chat on open and leaves the note focused when the account check finishes later", () => {
  state.agent.statusLoading = true;
  act(() => container.querySelector("button")!.click());
  nextFrame();
  expect(document.activeElement).toBe(container.querySelector("textarea"));
  act(() => editor.view.focus());
  state.agent.statusLoading = false;
  act(() => root.render(<Workspace />));
  nextFrame();
  expect(document.activeElement).toBe(editor.view.dom);
});

it("leaves the note focused when leaving focus mode shows the panel again", () => {
  const [toggle, focusMode] = container.querySelectorAll("button");
  act(() => toggle.click());
  nextFrame();
  act(() => editor.view.focus());
  act(() => focusMode.click());
  nextFrame();
  act(() => focusMode.click());
  nextFrame();
  expect(container.querySelector("aside")!.getAttribute("aria-hidden")).toBe("false");
  expect(document.activeElement).toBe(editor.view.dom);
});
