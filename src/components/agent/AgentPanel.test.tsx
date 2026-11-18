// @vitest-environment jsdom
import { act, useCallback, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentChanges, ScratchDocument } from "../editor/AgentChanges";
import { TooltipProvider } from "../ui";
import { AgentPanel, orderedStarters } from "./AgentPanel";
import { useAgentPanelShortcut } from "./useAgentPanelShortcut";
import type * as AgentContext from "../../context/AgentContext";
import { prepareWritingOffer } from "../../lib/agent/writingOffers";
import { AgentLauncher } from "./AgentLauncher";
import { invoke } from "@tauri-apps/api/core";

const state = vi.hoisted(() => ({ agent: {} as Record<string, unknown> }));
vi.mock("../../context/AgentContext", async (original) => ({
  ...await original<typeof AgentContext>(),
  useAgent: () => state.agent,
}));
vi.mock("../../context/NotesContext", () => ({
  useNotes: () => ({ currentNote: { id: "note", title: "Note" }, selectNote: vi.fn() }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const editorElement = document.body.appendChild(document.createElement("div"));
  editor = new Editor({ element: editorElement, extensions: [StarterKit, ScratchDocument, AgentChanges], content: "<p>A note that must not become a quote.</p>" });
  editor.storage.scratchDocument.noteId = "note";
  vi.mocked(invoke).mockReset().mockResolvedValue({ intent: "discuss", confidence: 0.95, route: "fast" });
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  state.agent = {
    editor, width: 360, composerFocusRequest: 0,
    status: { status: "ready", account: null },
    statusLoading: false, modelsLoading: false,
    model: "model", models: [{ id: "model", label: "Model" }],
    history: [], conversation: { items: [], runId: null },
    writingOffer: null, writingOfferDraft: "", writingOfferReplay: 0,
    setWritingOfferDraft: vi.fn(), requestWritingHelp: vi.fn().mockResolvedValue(undefined),
    acceptWritingOffer: vi.fn(), showWritingOffer: vi.fn(), dismissWritingSuggestion: vi.fn(),
    send: vi.fn().mockResolvedValue(true), prepareCompanionMessage: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined), startCompanion: vi.fn().mockResolvedValue(undefined),
    pendingQuestion: null, coediting: true, openRequest: false, companionChecking: false,
    writingFocus: null, writingTarget: null, writingSuggestion: null, writingStarters: [],
  };
  act(() => root.render(<Workspace />));
});

afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function nextFrame() {
  act(() => vi.advanceTimersByTime(20));
}

it("shares the current proposal and stages Add to chat in the sidebar without sending", () => {
  const prepared = prepareWritingOffer(editor, { kind: "rewrite", quote: "A note that must not become a quote.",
    replacement: "An improved sentence.", explanation: "Keep the thought direct.", question: null,
    destination: null, trace: [], sources: [] });
  state.agent.writingOffer = { id: "offer", prepared, stale: false };
  state.agent.writingOfferDraft = "The writer's revision.";
  act(() => container.querySelector("button")!.click());
  nextFrame();
  expect(container.querySelector('[aria-label="Proposed wording"]')!.textContent).toBe("The writer's revision.");
  const click = (label: string) => act(() => [...container.querySelectorAll("button")].find(button => button.textContent === label)!.click());
  click("Add to chat");
  const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Message agent"]')!;
  expect(input.value).toContain("A note that must not become a quote.");
  expect(input.value).toContain("The writer's revision.");
  expect(input.value).not.toContain("An improved sentence.");
  expect(document.activeElement).toBe(input);
  expect(state.agent.send).not.toHaveBeenCalled();
  click("Show passage");
  expect(state.agent.showWritingOffer).toHaveBeenCalledOnce();
  click("Accept rewrite");
  expect(state.agent.acceptWritingOffer).toHaveBeenCalledExactlyOnceWith("The writer's revision.");
});

it("resolves a model-authored card in the sidebar without adding a duplicate", () => {
  const prepared = prepareWritingOffer(editor, { kind: "question", quote: "A note that must not become a quote.",
    replacement: null, explanation: "One connection is missing.", question: "Why does this follow?",
    destination: null, trace: [], sources: [] });
  state.agent.writingOffer = { id: "offer", prepared, stale: false };
  state.agent.writingOfferDraft = "The incentives changed.";
  state.agent.conversation = { runId: null, items: [{ id: "reply", type: "text", text: [
    "```spec", '{"op":"add","path":"/root","value":"card"}',
    '{"op":"add","path":"/elements/card","value":{"type":"WritingSuggestion","props":{"id":"offer"},"children":[]}}', "```",
  ].join("\n") }] };
  act(() => container.querySelector("button")!.click());
  nextFrame();
  expect(container.querySelectorAll(".writing-offer-card")).toHaveLength(1);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Answer the writing question"]')!.value).toBe("The incentives changed.");
  act(() => [...container.querySelectorAll("button")].find(button => button.textContent === "Send answer")!.click());
  expect(state.agent.requestWritingHelp).toHaveBeenCalledExactlyOnceWith("question", "The incentives changed.");
  expect(state.agent.send).not.toHaveBeenCalled();
});

it("shows computer setup as a notice while leaving chat available", () => {
  state.agent.conversation = {
    items: [], runId: null,
    computerUnavailable: { message: "Enable Screen Recording.", permissions: ["screen_recording"] },
  };
  act(() => root.render(<Workspace />));
  expect(container.textContent).toContain("Computer access unavailable");
  expect(container.textContent).toContain("Chat and note editing are still available.");
  expect(container.textContent).not.toContain("Check account again");
  expect(container.querySelector("textarea")!.disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("does not suggest account recovery for unrelated errors", () => {
  state.agent.conversation = { items: [], runId: null, error: { kind: "other", message: "Connection interrupted" } };
  act(() => root.render(<Workspace />));
  expect(container.textContent).toContain("Send another message to try again.");
  expect(container.textContent).not.toContain("Check account again");
});

it("retries a writing check directly from its error", () => {
  state.agent.startCompanion = vi.fn();
  state.agent.conversation = { items: [], runId: null, error: { kind: "writing_review", message: "Decisions timed out." } };
  act(() => root.render(<Workspace />));
  act(() => container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
  expect(state.agent.startCompanion).toHaveBeenCalledOnce();
  expect(state.agent.send).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Send another message");
});

it("scrolls to the latest streaming text after the writer has scrolled up", () => {
  act(() => container.querySelector("button")!.click());
  const log = container.querySelector<HTMLElement>('[role="log"]')!;
  Object.defineProperty(log, "scrollHeight", { value: 900 });
  for (const text of ["First", "First and second"]) {
    log.scrollTop = 12;
    act(() => log.dispatchEvent(new Event("scroll")));
    state.agent.conversation = { runId: "run", items: [{ id: "reply", type: "text", text }] };
    act(() => root.render(<Workspace />));
    expect(log.scrollTop).toBe(900);
  }
});

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
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click(); });
  expect(state.agent.send).toHaveBeenCalledWith(expect.stringContaining("Help with this note"), undefined, "coedit", expect.anything());
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

it("offers a runtime retry rather than sign-in when Codex cannot start", () => {
  const refreshStatus = vi.fn();
  state.agent.status = { status: "error", detail: "The bundled Codex runtime is missing.", account: null };
  state.agent.refreshStatus = refreshStatus;
  act(() => container.querySelector("button")!.click());
  expect(container.textContent).toContain("The bundled Codex runtime is missing.");
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.some(button => button.textContent === "Continue with ChatGPT")).toBe(false);
  const retry = buttons.find(button => button.textContent === "Try again")!;
  act(() => retry.click());
  expect(refreshStatus).toHaveBeenCalledOnce();
});

function openPanel() {
  act(() => container.querySelector("button")!.click());
  nextFrame();
  return container.querySelector<HTMLTextAreaElement>('[aria-label="Message agent"]')!;
}
function type(input: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function send() {
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click(); });
}
const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label)!;

it("routes an edit request to the classifier's model and leaves it open for the writer's later edits", async () => {
  vi.mocked(invoke).mockResolvedValue({ intent: "edit", confidence: 0.95, route: "fast" });
  const input = openPanel();
  type(input, "Tighten this paragraph");
  await send();
  expect(state.agent.prepareCompanionMessage).toHaveBeenCalledOnce();
  const [prompt, computer, mode, options] = vi.mocked(state.agent.send as (...args: unknown[]) => unknown).mock.calls[0];
  expect(prompt).toContain("Response mode: edit.");
  expect(prompt).toContain("User instruction:\n\nTighten this paragraph");
  // Computer access follows the user's setting, not the surface the message came from.
  expect(computer).toBeUndefined();
  expect(mode).toBe("coedit");
  expect(options).toEqual({ route: "fast", openRequest: true });
  expect(input.value).toBe("");
});

it("keeps a question from turning the writer's next edits into agent edits", async () => {
  const input = openPanel();
  type(input, "Does this argument hold?");
  await send();
  expect(state.agent.send).toHaveBeenCalledWith(expect.stringContaining("Response mode: discuss."), undefined, "coedit",
    { route: "fast", openRequest: false });
});

it.each([
  ["the classifier fails", () => vi.mocked(invoke).mockRejectedValue(new Error("Offline")), "Help me anyway"],
  ["the classifier is slow", () => vi.mocked(invoke).mockReturnValue(new Promise(() => {})), "Help me anyway"],
  ["the message is too long to classify", () => {}, "x".repeat(8001)],
])("sends the message unrouted on the selected model when %s", async (_case, arrange, text) => {
  arrange();
  const input = openPanel();
  type(input, text);
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  const [prompt, , , options] = vi.mocked(state.agent.send as (...args: unknown[]) => unknown).mock.calls[0];
  expect(prompt).toContain(text);
  expect(prompt).not.toContain("Response mode:");
  expect(options).toEqual({ route: undefined, openRequest: true });
});

it("does not send a message to a note that was opened while it was being routed", async () => {
  let classify!: (decision: unknown) => void;
  vi.mocked(invoke).mockReturnValue(new Promise(resolve => { classify = resolve; }));
  const input = openPanel();
  type(input, "Tighten this paragraph");
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
  editor.storage.scratchDocument.session++;
  await act(async () => { classify({ intent: "edit", confidence: 0.95, route: "fast" }); });
  expect(state.agent.send).not.toHaveBeenCalled();
  expect(input.value).toBe("Tighten this paragraph");
});

it("keeps a message that could not be sent", async () => {
  state.agent.send = vi.fn().mockResolvedValue(false);
  const input = openPanel();
  type(input, "Tighten this paragraph");
  await send();
  expect(input.value).toBe("Tighten this paragraph");
});

it("shows what the writer typed, not the context sent with it", () => {
  state.agent.conversation = { runId: null, items: [{ id: "u", type: "user",
    text: "Inline agent request. Respond to the user's instruction.\n\nUser instruction:\n\nTighten this paragraph" }] };
  openPanel();
  const log = container.querySelector('[role="log"]')!;
  expect(log.textContent).toContain("Tighten this paragraph");
  expect(log.textContent).not.toContain("Inline agent request");
});

it("offers the four ways to work together until the writer starts typing", () => {
  const input = openPanel();
  act(() => button("Check a claim").click());
  expect(state.agent.requestWritingHelp).toHaveBeenCalledExactlyOnceWith("evidence");
  expect(state.agent.send).not.toHaveBeenCalled();
  type(input, "My own question");
  expect(button("Check a claim")).toBeUndefined();
});

it("shows the face with the reason for a concern, and lets the writer explore or dismiss the suggestion", () => {
  state.agent.writingFocus = "evidence";
  state.agent.writingSuggestion = { id: "s", text: "This claim needs a source.", documentSession: 0 };
  const input = openPanel();
  const face = container.querySelector(".agent-panel-header .inline-agent-face")!;
  expect(face.getAttribute("data-expression")).toBe("concerned");
  expect(container.querySelector('[role="status"]')!.textContent).toBe("A claim worth checking");
  act(() => button("Explore this").click());
  expect(input.value).toContain("This claim needs a source.");
  expect(state.agent.dismissWritingSuggestion).toHaveBeenCalledOnce();
  expect(state.agent.send).not.toHaveBeenCalled();
});

it("shows the model's expression while it works and a paused face after Pause", () => {
  state.agent.conversation = { runId: "run", items: [{ id: "u", type: "user", text: "Hi" }],
    expression: { expression: "pleased", sentiment: 0.6, intensity: 0.7 } };
  openPanel();
  const face = () => container.querySelector(".agent-panel-header .inline-agent-face")!;
  expect(face().getAttribute("data-expression")).toBe("pleased");
  act(() => button("Pause").click());
  expect(state.agent.stop).toHaveBeenCalledOnce();
  state.agent.conversation = { runId: null, items: [], cancelled: true };
  state.agent.coediting = false;
  act(() => root.render(<Workspace />));
  expect(face().getAttribute("data-state")).toBe("paused");
  expect(container.querySelector('[role="status"]')!.textContent).toBe("Paused");
  act(() => button("Write with me").click());
  expect(state.agent.startCompanion).toHaveBeenCalledOnce();
});

it("sends an uncertain classification without a response mode, so the agent reads the message itself", async () => {
  vi.mocked(invoke).mockResolvedValue({ intent: "suggest", confidence: 0.6, route: "deep" });
  const input = openPanel();
  type(input, "Rewrite this paragraph");
  await send();
  const [prompt, , , options] = vi.mocked(state.agent.send as (...args: unknown[]) => unknown).mock.calls[0];
  expect(prompt).not.toContain("Response mode:");
  expect(options).toEqual({ route: "deep", openRequest: true });
});

it("tells the writer what the agent changed on its own and offers the way back", () => {
  state.agent.writingSuggestion = { id: "s", text: "Tightened the opening.", documentSession: 0, applied: true };
  state.agent.undoAppliedSuggestion = vi.fn();
  openPanel();
  expect(container.querySelector(".agent-panel-observation")!.textContent).toContain("I changed this: Tightened the opening.");
  expect(button("Explore this")).toBeUndefined();
  act(() => button("Undo").click());
  expect(state.agent.undoAppliedSuggestion).toHaveBeenCalledOnce();
});

it("says when an earlier request is still open for the writer's edits", () => {
  state.agent.openRequest = true;
  openPanel();
  expect(container.querySelector('[role="status"]')!.textContent).toBe("Coediting with you");
});

it("opens the composer with Cmd+Option+Enter from the note, and nowhere else", () => {
  const press = (target: Element) => act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", metaKey: true, altKey: true, bubbles: true, cancelable: true }));
  });
  const panel = container.querySelector("aside")!;
  const unrelated = document.body.appendChild(document.createElement("input"));
  unrelated.focus();
  press(unrelated);
  nextFrame();
  expect(panel.getAttribute("aria-hidden")).toBe("true");

  editor.view.dom.parentElement!.setAttribute("data-writing-workspace", "");
  act(() => { editor.view.focus(); editor.commands.setTextSelection(5); });
  const before = editor.getJSON();
  press(editor.view.dom);
  nextFrame();
  expect(panel.getAttribute("aria-hidden")).toBe("false");
  expect(document.activeElement).toBe(container.querySelector("textarea"));
  expect(editor.state.selection.from).toBe(5);
  expect(editor.getJSON()).toEqual(before);
});

it("keeps the face and what it is doing on a launcher while the panel is hidden", () => {
  state.agent.writingFocus = "clarity";
  state.agent.refreshStatus = vi.fn();
  const onOpen = vi.fn();
  act(() => root.render(<AgentLauncher onOpen={onOpen} />));
  const launcher = container.querySelector<HTMLButtonElement>(".agent-launcher")!;
  expect(launcher.querySelector(".inline-agent-face")!.getAttribute("data-expression")).toBe("uncertain");
  expect(launcher.textContent).toContain("A passage worth another look");
  // Showing the launcher costs nothing: no account check, no review.
  expect(state.agent.refreshStatus).not.toHaveBeenCalled();
  expect(state.agent.startCompanion).not.toHaveBeenCalled();
  act(() => launcher.click());
  expect(onOpen).toHaveBeenCalledOnce();
});

const suggestions = (id: string, ...items: string[]) => ({ id, type: "text", text: [
  "Done.", "```spec", '{"op":"add","path":"/root","value":"next"}',
  JSON.stringify({ op: "add", path: "/elements/next", value: { type: "Suggestions", props: { items }, children: [] } }), "```",
].join("\n") });

it("sends a suggested next step exactly as shown, from the latest reply only, and leaves the draft alone", async () => {
  state.agent.conversation = { runId: null, items: [
    { id: "u1", type: "user", text: "First" }, suggestions("a1", "Old idea"),
    { id: "u2", type: "user", text: "Second" }, suggestions("a2", "Tighten the ending", "Check the dates"),
  ] };
  const input = openPanel();
  type(input, "A half-written thought");
  expect(button("Old idea").disabled).toBe(true);
  await act(async () => { button("Tighten the ending").click(); });
  const [prompt] = vi.mocked(state.agent.send as (...args: unknown[]) => unknown).mock.calls[0];
  expect(prompt).toContain("User instruction:\n\nTighten the ending");
  expect(state.agent.send).toHaveBeenCalledOnce();
  expect(input.value).toBe("A half-written thought");
});

it("holds suggested next steps while the agent is working", () => {
  state.agent.conversation = { runId: "run", items: [{ id: "u", type: "user", text: "Go" }, suggestions("a", "Check the dates")] };
  openPanel();
  expect(button("Check the dates").disabled).toBe(true);
});

it("puts the help that fits the passage first and marks it, without changing which help is on offer", () => {
  expect(orderedStarters(null).map(starter => starter.kind)).toEqual(["rewrite", "question", "evidence", "move"]);
  expect(orderedStarters(null).some(starter => starter.fitting)).toBe(false);
  // A weak lead reorders nothing worth pointing at.
  expect(orderedStarters({ clarity: 0.1, evidence: 0.4, development: 0.2 })[0]).toMatchObject({ kind: "evidence", fitting: false });
  state.agent.writingScores = { clarity: 0.2, evidence: 0.8, development: 0.3 };
  openPanel();
  const starters = [...container.querySelectorAll(".agent-panel-starters button")];
  expect(starters.map(item => item.textContent)).toEqual(["Check a claim", "Trace my argument", "Explore the order", "Show a version"]);
  expect(starters.map(item => item.hasAttribute("data-fitting"))).toEqual([true, false, false, false]);
});

it("replaces the standing starters with the agent's own next moves for this note and sends one as a message", async () => {
  state.agent.writingStarters = ["Connect Venus to the opening", "Find a source for the Venus day"];
  openPanel();
  const starters = [...container.querySelectorAll(".agent-panel-starters button")];
  expect(starters.map(item => item.textContent)).toEqual(["Connect Venus to the opening", "Find a source for the Venus day"]);
  await act(async () => { button("Connect Venus to the opening").click(); });
  expect(state.agent.requestWritingHelp).not.toHaveBeenCalled();
  const [prompt] = vi.mocked(state.agent.send as (...args: unknown[]) => unknown).mock.calls[0];
  expect(prompt).toContain("User instruction:\n\nConnect Venus to the opening");
});
