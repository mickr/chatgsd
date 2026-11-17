// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { captureRunBinding, releaseRunBinding } from "../../lib/agent/documentTools";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentChanges, ScratchDocument, attachedRange } from "../editor/AgentChanges";
import { InlineAgentPrompt, inlineEditPrompt } from "./InlineAgentPrompt";
import type { Conversation } from "../../context/AgentContext";

const state = vi.hoisted(() => ({ agent: {} as Record<string, unknown> }));
vi.mock("../../context/AgentContext", () => ({ useAgent: () => state.agent }));
vi.mock("../../context/NotesContext", () => ({ useNotes: () => ({ selectNote: vi.fn() }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let editor: Editor;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement("div");
  document.body.append(container);
  editor = new Editor({ extensions: [StarterKit, Markdown, ScratchDocument, AgentChanges], content: "<p>Before paragraph.</p><p>Target paragraph.</p><p>After paragraph.</p>" });
  editor.storage.scratchDocument.noteId = "note";
  document.body.append(editor.view.dom);
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ top: 100, bottom: 120, left: 100, right: 100 });
  state.agent = {
    editor, status: { status: "ready" }, refreshStatus: vi.fn().mockResolvedValue(undefined),
    conversation: { runId: null, error: null, items: [], cancelled: false },
    send: vi.fn().mockResolvedValue(true), answerQuestion: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  root = createRoot(container);
  act(() => root.render(<InlineAgentPrompt onContinue={vi.fn()} />));
});
afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function open() {
  editor.view.dom.focus();
  act(() => editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter", key: "Enter", metaKey: true, altKey: true, bubbles: true, cancelable: true })));
}

function composerInput() {
  if (!document.querySelector("textarea")) {
    act(() => document.querySelector<HTMLButtonElement>(".inline-agent-dock-toggle")!.click());
  }
  return document.querySelector("textarea")!;
}

it("opens on Cmd+Option+Enter without inserting a newline or losing the target", () => {
  editor.commands.setTextSelection({ from: 20, to: 26 });
  const before = editor.getJSON();
  open();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Inline edit instruction");
  expect(attachedRange(editor)).toEqual({ from: 20, to: 26 });
  expect(editor.getJSON()).toEqual(before);
  act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(editor.getJSON()).toEqual(before);
});

it("sends surrounding prose with the selected target through the shared agent", async () => {
  editor.commands.setTextSelection({ from: 20, to: 26 });
  open();
  const input = document.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Make it shorter");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  const prompt = vi.mocked(state.agent.send as (prompt: string) => Promise<boolean>).mock.calls[0][0];
  expect(prompt).toContain("Before paragraph.");
  expect(prompt).toContain("After paragraph.");
  expect(prompt).toContain("attached selection");
  expect(prompt).toContain("Make it shorter");
  expect(document.querySelector("textarea")).toBeNull();
  expect(composerInput().value).toBe("");
});

it("identifies an insertion cursor and bounds context instead of attaching the whole note", () => {
  editor.commands.setContent(`<p>${"A".repeat(5000)}CURSOR${"B".repeat(5000)}</p>`);
  editor.commands.setTextSelection(5001);
  const prompt = inlineEditPrompt(editor, "Add a transition");
  expect(prompt).toContain('"target":"cursor"');
  expect(prompt).toContain('"after":"CURSOR');
  expect(prompt).not.toContain("A".repeat(2001));
  expect(prompt).not.toContain("B".repeat(2001));
  expect(prompt).toContain("read_document");
});

it("does not intercept the shortcut in unrelated inputs", () => {
  const other = document.createElement("input");
  document.body.append(other);
  other.focus();
  act(() => other.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter", metaKey: true, altKey: true, bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it.each([true, false])("retains and maps the selection after binding capture returns %s", async (started) => {
  const selections: Array<string | null> = [];
  const send = vi.fn(async () => {
    const binding = captureRunBinding(editor, `run-${selections.length}`)!;
    selections.push(binding.selectionMarkdown);
    releaseRunBinding(editor, binding);
    return started;
  });
  state.agent.send = send;
  editor.commands.setTextSelection({ from: 20, to: 26 });
  open();
  let input = composerInput();
  const submit = async (instruction: string) => {
    input = composerInput();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, instruction);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  };
  await submit("Rewrite this");
  expect(selections).toEqual(["Target"]);
  expect(attachedRange(editor)).toBeNull();
  if (!started) expect(composerInput().value).toBe("Rewrite this");

  // A retry must recapture the same selection, not the collapsed cursor.
  await submit("Try again");
  expect(selections).toEqual(["Target", "Target"]);

  // Replacement and unrelated earlier edits both move the retained target.
  act(() => {
    editor.commands.insertContentAt({ from: 20, to: 26 }, "Revised");
    editor.commands.insertContentAt(1, "Earlier ");
  });
  await submit("Make that shorter");
  expect(selections).toEqual(["Target", "Target", "Revised"]);
});

it("checks an initially unknown account on inline open and enables sending when ready", async () => {
  state.agent.status = null;
  let resolveStatus!: () => void;
  const statusReady = new Promise<void>((resolve) => { resolveStatus = resolve; });
  const render = () => root.render(<InlineAgentPrompt onContinue={vi.fn()} />);
  state.agent.refreshStatus = vi.fn(async () => {
    state.agent.statusLoading = true;
    render();
    await statusReady;
    state.agent.status = { status: "ready" };
    state.agent.statusLoading = false;
    render();
  });
  act(render);
  open();
  expect(document.querySelector('[role="status"]')?.textContent).toBe("Checking your ChatGPT account…");
  const input = document.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Shorten this");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Send inline edit"]')?.disabled).toBe(true);
  await act(async () => { resolveStatus(); await statusReady; });
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Send inline edit"]')?.disabled).toBe(false);
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(state.agent.send).toHaveBeenCalledOnce();
  expect(state.agent.refreshStatus).toHaveBeenCalledOnce();
});

it("docks while working, reveals real turns, and keeps activity visible when writing resumes", async () => {
  const onContinue = vi.fn();
  act(() => root.render(<InlineAgentPrompt onContinue={onContinue} />));
  let conversation: Conversation = { items: [], runId: null, sessionId: null, context: null, error: null, cancelled: false };
  state.agent.send = vi.fn(async (prompt: string) => {
    conversation = { ...conversation, runId: "run", items: [{ id: "user", type: "user", text: prompt }] };
    state.agent.conversation = conversation;
    return true;
  });
  open();
  const input = composerInput();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Make it shorter");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(document.querySelector('.inline-agent-dock[data-state="thinking"]')).not.toBeNull();
  expect(document.querySelector(".inline-agent-dock-copy > :first-child")?.textContent).toBe("Make it shorter");
  expect(document.querySelector(".inline-agent-dock-copy")?.textContent).not.toContain("surrounding prose");
  expect(document.querySelector("textarea")).toBeNull();

  conversation = { ...conversation, items: [...conversation.items,
    { id: "tool", type: "tool", name: "read_document", input: {} }] };
  state.agent.conversation = conversation;
  act(() => root.render(<InlineAgentPrompt onContinue={onContinue} />));
  expect(document.querySelector('.inline-agent-dock[data-state="reading"]')).not.toBeNull();
  composerInput();
  const log = document.querySelector('[aria-label="Inline conversation turns"]')!;
  expect(log.textContent).toContain("Make it shorter");
  expect(log.textContent).toContain("Read note");
  expect(log.textContent).not.toContain("Surrounding prose (up to");
  act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(document.querySelector('[aria-label="Inline conversation turns"]')).toBeNull();
  expect(document.querySelector(".inline-agent-dock-toggle")?.getAttribute("aria-expanded")).toBe("false");
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Pause agent"]')!.click());
  expect(state.agent.stop).toHaveBeenCalledOnce();

  const question = { id: "question", type: "question" as const, runId: "run", requestId: "request",
    question: "Keep the technical detail?", options: ["Keep it", "Simplify"], form: null, answer: null };
  state.agent.pendingQuestion = question;
  state.agent.conversation = { ...conversation, items: [...conversation.items, question] };
  act(() => root.render(<InlineAgentPrompt onContinue={onContinue} />));
  expect(document.querySelector(".inline-agent-dock-copy > :first-child")?.textContent).toBe(question.question);
  composerInput();
  act(() => [...document.querySelectorAll("button")].find((button) => button.textContent === "Keep it")!.click());
  expect(state.agent.answerQuestion).toHaveBeenCalledWith("Keep it");
  act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[aria-label="Inline conversation turns"]')).toBeNull();
  expect(document.activeElement?.getAttribute("aria-expanded")).toBe("false");
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open in sidebar"]')!.click());
  expect(onContinue).toHaveBeenCalledOnce();
  expect(document.querySelector(".inline-agent-prompt")).toBeNull();
  expect(state.agent.stop).toHaveBeenCalledOnce();
});
