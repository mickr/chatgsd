// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { captureRunBinding, releaseRunBinding } from "../../lib/agent/documentTools";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentChanges, ScratchDocument, attachedRange } from "../editor/AgentChanges";
import { InlineAgentPrompt, inlineAgentPrompt } from "./InlineAgentPrompt";
import type { Conversation } from "../../context/AgentContext";
import { invoke } from "@tauri-apps/api/core";

const state = vi.hoisted(() => ({ agent: {} as Record<string, unknown> }));
vi.mock("../../context/AgentContext", () => ({ useAgent: () => state.agent }));
vi.mock("../../context/NotesContext", () => ({ useNotes: () => ({ selectNote: vi.fn() }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let editor: Editor;

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue({ intent: "discuss", confidence: 0.95 });
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

it("offers a visible trigger before opening without requesting account or model access", () => {
  expect(document.querySelector('[aria-label="Open inline agent"]')?.textContent).toContain("Ask agent");
  expect(state.agent.refreshStatus).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open inline agent"]')!.click());
  expect(document.querySelector('[aria-label="Inline conversation turns"]')).not.toBeNull();
  expect(document.activeElement).toBe(composerInput());
  expect(state.agent.send).not.toHaveBeenCalled();
});

it("restores the draft and transcript without stopping a running agent", async () => {
  state.agent.conversation = { runId: "run", error: null, items: [
    { id: "user", type: "user", text: "Explain this" },
    { id: "reply", type: "text", text: "Here is the explanation" },
  ], cancelled: false };
  open();
  const input = composerInput();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "A follow-up");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close inline agent"]')!.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(state.agent.stop).not.toHaveBeenCalled();
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open inline agent"]')!.click());
  expect(composerInput().value).toBe("A follow-up");
  expect(document.querySelector('[role="log"]')?.textContent).toContain("Here is the explanation");
  expect(document.activeElement).toBe(composerInput());
  expect(state.agent.send).not.toHaveBeenCalled();
  await act(async () => {});
});

it("maps the retained passage while closed and restores it through the trigger", async () => {
  const selections: Array<string | null> = [];
  state.agent.send = vi.fn(async () => {
    const binding = captureRunBinding(editor, "run")!;
    selections.push(binding.selectionMarkdown);
    releaseRunBinding(editor, binding);
    return true;
  });
  editor.commands.setTextSelection({ from: 20, to: 26 });
  open();
  const submit = async () => {
    const input = composerInput();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Explain this passage");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  };
  await submit();
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close inline agent"]')!.click());
  act(() => {
    editor.commands.insertContentAt({ from: 20, to: 26 }, "Revised");
    editor.commands.insertContentAt(1, "Earlier ");
    editor.commands.setTextSelection(1);
  });
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open inline agent"]')!.click());
  await submit();
  expect(selections).toEqual(["Target", "Revised"]);
});

it("clears an accepted message if the interface closes while sending", async () => {
  let accept!: (sent: boolean) => void;
  state.agent.send = vi.fn(() => new Promise<boolean>((resolve) => { accept = resolve; }));
  open();
  const input = composerInput();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Explain this");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(state.agent.send).toHaveBeenCalledOnce();
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close inline agent"]')!.click());
  await act(async () => { accept(true); });
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open inline agent"]')!.click());
  expect(composerInput().value).toBe("");
  expect(state.agent.stop).not.toHaveBeenCalled();
});

it("opens on Cmd+Option+Enter without inserting a newline or losing the target", () => {
  editor.commands.setTextSelection({ from: 20, to: 26 });
  const before = editor.getJSON();
  open();
  expect(document.activeElement).toBe(document.querySelector("textarea"));
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
  expect(document.activeElement).toBe(input);
  expect(composerInput().value).toBe("");
});

it("includes cursor context without attaching the whole note", () => {
  editor.commands.setContent(`<p>${"A".repeat(5000)}CURSOR${"B".repeat(5000)}</p>`);
  editor.commands.setTextSelection(5001);
  const prompt = inlineAgentPrompt(editor, "What would make a good transition?");
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
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
  await act(async () => { resolveStatus(); await statusReady; });
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(false);
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(state.agent.send).toHaveBeenCalledOnce();
  expect(state.agent.refreshStatus).toHaveBeenCalledOnce();
});

it("keeps the conversation open while working and writing, with explicit minimize and sidebar controls", async () => {
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
  expect(document.activeElement).toBe(input);

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
  expect(document.querySelector('[aria-label="Inline conversation turns"]')).toBe(log);
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Collapse conversation turns"]')!.click());
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
  expect(document.querySelector('[aria-label="Open inline agent"]')).not.toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(state.agent.stop).toHaveBeenCalledOnce();
});

it("does not send or change notes when classification fails and keeps the message for retry", async () => {
  open();
  await act(async () => {});
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Decisions unavailable"));
  const before = editor.getJSON();
  const input = composerInput();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "What do you think?");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(state.agent.send).not.toHaveBeenCalled();
  expect(editor.getJSON()).toEqual(before);
  expect(composerInput().value).toBe("What do you think?");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Decisions unavailable");
});

it.each(["Open sidebar", "Pause agent", "Close inline agent"])("ignores a pending classification after %s", async (action) => {
  open();
  await act(async () => {});
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const input = composerInput();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Explain this");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  act(() => [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label") === action || button.textContent === action)!.click());
  await act(async () => { resolve({ intent: "discuss", confidence: 0.9 }); });
  expect(state.agent.send).not.toHaveBeenCalled();
  if (action === "Pause agent") {
    expect(state.agent.stop).toHaveBeenCalledOnce();
    expect(composerInput().value).toBe("Explain this");
    expect(composerInput().disabled).toBe(false);
  }
});

it("does not send an old request against a newly invoked passage", async () => {
  editor.commands.setTextSelection({ from: 20, to: 26 });
  open();
  await act(async () => {});
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const input = composerInput();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Rewrite this");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  act(() => editor.commands.setTextSelection({ from: 39, to: 44 }));
  open();
  await act(async () => { resolve({ intent: "edit", confidence: 0.95 }); });
  expect(state.agent.send).not.toHaveBeenCalled();
  const calls = vi.mocked(invoke).mock.calls;
  expect(calls[calls.length - 1][1]).toMatchObject({ context: { message: "", selection: "After" } });
  expect(composerInput().disabled).toBe(false);
});

it("offers classified suggestions without sending until the user submits", async () => {
  vi.mocked(invoke).mockResolvedValue({ intent: "research", confidence: 0.95 });
  open();
  await act(async () => {});
  const suggestion = document.querySelector<HTMLButtonElement>(".inline-agent-suggestions button")!;
  const text = suggestion.textContent;
  act(() => suggestion.click());
  expect(composerInput().value).toBe(text);
  expect(state.agent.send).not.toHaveBeenCalled();
});

it("allows discussion after the selected context was deleted", async () => {
  editor.commands.setTextSelection({ from: 20, to: 26 });
  open();
  act(() => editor.commands.deleteRange({ from: 20, to: 26 }));
  const input = composerInput();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "What should go here instead?");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(state.agent.send).toHaveBeenCalledOnce();
});
