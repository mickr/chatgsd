// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ScratchDocument, setChangeMeta } from "../components/editor/AgentChanges";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "../services/agent";
import * as notes from "../services/notes";
import type { Note } from "../types/note";
import { executeDocumentTool } from "../lib/agent/documentTools";
import { AgentPanel } from "../components/agent/AgentPanel";
import { TooltipProvider } from "../components/ui";
import {
  AgentProvider,
  useAgent,
  type AgentContextValue,
} from "./AgentContext";

const mocks = vi.hoisted(() => ({
  currentNote: null as Note | null,
  toolHandler: null as ((request: agent.ToolRequest) => void) | null,
  eventHandler: null as ((payload: agent.AgentEventPayload) => void) | null,
}));

vi.mock("../services/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof agent>()),
  getStatus: vi.fn(),
  listModels: vi.fn(),
  startRun: vi.fn(),
  reviewWriting: vi.fn(),
  classifyInlineContext: vi.fn(),
  toolRespond: vi.fn(() => Promise.resolve()),
  cancelRun: vi.fn(() => Promise.resolve()),
  listConversations: vi.fn(),
  loadConversation: vi.fn(),
  saveConversation: vi.fn(() => Promise.resolve()),
  onAgentEvent: vi.fn((handler: (payload: agent.AgentEventPayload) => void) => {
    mocks.eventHandler = handler;
    return Promise.resolve(() => {});
  }),
  onToolRequest: vi.fn((handler: (request: agent.ToolRequest) => void) => {
    mocks.toolHandler = handler;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("../services/notes", () => ({
  getSettings: vi.fn(() => Promise.resolve({})),
  updateSettings: vi.fn(() => Promise.resolve()),
}));
vi.mock("./NotesContext", () => ({
  useNotes: () => ({
    currentNote: mocks.currentNote,
    notesFolder: "/notes",
    selectNote: vi.fn(),
  }),
}));
vi.mock("../lib/agent/documentTools", () => ({
  captureRunBinding: (_editor: unknown, runId: string) => ({
    runId,
    documentSession: 1,
    noteId: "trip",
    noteTitle: "Trip plan",
    selectionMarkdown: null,
    focusRangeId: null,
  }),
  releaseRunBinding: vi.fn(),
  executeDocumentTool: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const READY: agent.AgentStatus = {
  status: "ready",
  detail: null,
  account: { email: "me@example.com", planUsage: true, planNoticeSeen: true },
};
let editor: Editor;

let root: Root;
let current: AgentContextValue;

function Probe() {
  current = useAgent();
  return null;
}

/** Let the mocked request promises and the effects they trigger settle. */
async function settle() {
  await act(async () => {
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
  });
}

async function startRunAndAsk(args: Record<string, unknown>) {
  act(() => current.toggle());
  await settle();
  await act(async () => {
    await current.send("Plan the trip");
  });
  act(() =>
    mocks.toolHandler?.({
      requestId: "q1",
      runId: "run-1",
      name: "ask_user",
      args,
    }),
  );
  await settle();
}

beforeEach(async () => {
  mocks.currentNote = {
    id: "trip",
    title: "Trip plan",
    content: "",
    path: "/notes/trip.md",
    modified: 0,
  };
  vi.mocked(agent.getStatus).mockResolvedValue(READY);
  vi.mocked(agent.classifyInlineContext).mockResolvedValue({ intent: "suggest", confidence: 0.95, route: "fast" });
  vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: null, anchor: null, route: "fast" });
  vi.mocked(agent.listModels).mockResolvedValue([{ id: "gpt-x", label: "GPT X" }]);
  vi.mocked(agent.startRun).mockResolvedValue({ runId: "run-1" });
  vi.mocked(agent.listConversations).mockResolvedValue([]);
  editor = new Editor({ extensions: [StarterKit, ScratchDocument], content: "<p>Trip plan</p>" });
  Object.assign(editor.storage.scratchDocument, { noteId: "trip", title: "Trip plan", session: 1 });
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      <AgentProvider editorRef={{ current: editor }} editor={editor}>
        <Probe />
      </AgentProvider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("keeps chat and document tools running after computer startup fails, then clears the notice on the next turn", async () => {
  act(() => current.toggle());
  await settle();
  await act(async () => { await current.send("Hello"); });
  act(() => mocks.eventHandler?.({ runId: "run-1", event: {
    type: "computer_unavailable", message: "Enable Screen Recording.", permissions: ["screen_recording"],
  } }));
  expect(current.conversation.runId).toBe("run-1");
  expect(current.conversation.error).toBeNull();
  expect(current.conversation.computerUnavailable?.permissions).toEqual(["screen_recording"]);
  vi.mocked(executeDocumentTool).mockResolvedValue({ ok: true, output: "Live note" });
  await act(async () => { await mocks.toolHandler?.({ requestId: "read-1", runId: "run-1", name: "read_document", args: {} }); });
  expect(agent.toolRespond).toHaveBeenCalledWith("read-1", true, "Live note");
  act(() => {
    mocks.eventHandler?.({ runId: "run-1", event: { type: "text_delta", text: "Hello!" } });
    mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } });
  });
  expect(current.conversation.items.some(item => item.type === "text" && item.text === "Hello!")).toBe(true);
  expect(current.conversation.error).toBeNull();
  expect(current.coediting).toBe(true);
  await act(async () => { await current.send("Keep editing"); });
  expect(current.conversation.computerUnavailable).toBeUndefined();
});

it.each(["toggle", "close"] as const)("returns focus to the note through %s without moving its cursor", async (action) => {
  const note = editor.view.dom.parentElement!;
  const composer = document.createElement("textarea");
  document.body.append(note, composer);
  try {
    act(() => current.toggle());
    await settle();
    editor.commands.setTextSelection(5);
    composer.focus();
    expect(document.activeElement).toBe(composer);
    vi.useFakeTimers();
    act(() => current[action]());
    await settle();
    act(() => vi.advanceTimersByTime(20));
    expect(current.open).toBe(false);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(5);
    expect(editor.state.selection.to).toBe(5);
  } finally {
    note.remove();
    composer.remove();
  }
});

it("moves focus between the note and an open panel without closing it or moving the cursor", async () => {
  const note = editor.view.dom.parentElement!;
  const composer = document.createElement("textarea");
  document.body.append(note, composer);
  try {
    act(() => current.focusPanel());
    await settle();
    const request = current.composerFocusRequest;
    editor.commands.setTextSelection(5);
    composer.focus();
    vi.useFakeTimers();
    act(() => current.focusNote());
    act(() => vi.advanceTimersByTime(20));
    expect(current.open).toBe(true);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(5);
    act(() => current.focusPanel());
    expect(current.open).toBe(true);
    expect(current.composerFocusRequest).toBe(request + 1);
  } finally {
    note.remove();
    composer.remove();
  }
});

it("keeps Markdown source focused when Cmd+Option+← follows → within one frame", async () => {
  function Panel() {
    return <TooltipProvider><AgentPanel visible={useAgent().open} /></TooltipProvider>;
  }
  const source = document.createElement("textarea");
  source.dataset.noteSource = "";
  const host = document.createElement("div");
  document.body.append(source, host);
  act(() => root.unmount());
  root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <AgentProvider editorRef={{ current: editor }} editor={editor}>
          <Probe />
          <Panel />
        </AgentProvider>,
      );
    });
    await settle();
    source.focus();
    vi.useFakeTimers();
    act(() => current.focusPanel());
    act(() => current.focusNote());
    act(() => vi.advanceTimersByTime(20));
    expect(current.open).toBe(true);
    expect(document.activeElement).toBe(source);

    act(() => current.focusPanel());
    act(() => vi.advanceTimersByTime(20));
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Message agent"]'));
  } finally {
    source.remove();
    host.remove();
  }
});

it.each(["toggle", "close"] as const)("returns focus to Markdown source through %s and preserves its selection", async (action) => {
  const source = document.createElement("textarea");
  source.dataset.noteSource = "";
  source.value = "# Trip plan\n\nPack a rain jacket.";
  const composer = document.createElement("textarea");
  document.body.append(source, composer);
  try {
    source.focus();
    source.setSelectionRange(13, 17);
    act(() => current.toggle());
    await settle();
    composer.focus();
    vi.useFakeTimers();
    act(() => current[action]());
    await settle();
    act(() => vi.advanceTimersByTime(20));
    expect(current.open).toBe(false);
    expect(document.activeElement).toBe(source);
    expect(source.selectionStart).toBe(13);
    expect(source.selectionEnd).toBe(17);
    expect(source.value).toBe("# Trip plan\n\nPack a rain jacket.");
  } finally {
    source.remove();
    composer.remove();
  }
});

describe("AgentProvider model list", () => {
  it("retries a failed model request while the account stays ready", async () => {
    vi.mocked(agent.listModels)
      .mockRejectedValueOnce(new Error("Network down"))
      .mockResolvedValueOnce([{ id: "gpt-x", label: "GPT X" }]);

    act(() => current.toggle());
    await settle();
    expect(current.status?.status).toBe("ready");
    expect(current.modelsError).toBe("Network down");
    expect(current.models).toEqual([]);

    // A status refresh alone returns "ready" again and must not be relied on.
    act(() => current.reloadModels());
    await settle();

    expect(agent.listModels).toHaveBeenCalledTimes(2);
    expect(current.status?.status).toBe("ready");
    expect(current.modelsError).toBeNull();
    expect(current.models).toEqual([{ id: "gpt-x", label: "GPT X" }]);
    expect(current.model).toBe("gpt-x");
  });
});

describe("AgentProvider ask_user", () => {
  it("sends the UI guide and returns a typed answer to the waiting run", async () => {
    await startRunAndAsk({
      question: "Which day do you leave?",
      options: ["Saturday", "Sunday"],
      form: null,
    });

    expect(vi.mocked(agent.startRun).mock.calls[0][0].uiGuide).toContain(
      "Scratch UI blocks",
    );
    expect(current.pendingQuestion).toMatchObject({
      question: "Which day do you leave?",
      options: ["Saturday", "Sunday"],
      form: null,
    });

    await act(async () => {
      await current.answerQuestion("Sunday");
    });

    expect(agent.toolRespond).toHaveBeenCalledWith(
      "q1",
      true,
      "The user answered: Sunday",
    );
    expect(current.pendingQuestion).toBeNull();
    const items = current.conversation.items;
    expect(items[items.length - 1]).toMatchObject({
      type: "question",
      answer: "Sunday",
    });
  });

  it("returns form answers as JSON and keeps a valid form spec", async () => {
    await startRunAndAsk({
      question: "A few details",
      options: [],
      form: {
        root: "day",
        elements: {
          day: {
            type: "Choice",
            props: {
              label: "Day",
              options: [{ value: "sun", label: "Sunday", description: null }],
              multiple: null,
              value: { $bindState: "/answers/day" },
            },
            children: [],
          },
        },
        state: { answers: { day: null } },
      },
    });
    expect(current.pendingQuestion?.form).not.toBeNull();

    await act(async () => {
      await current.answerQuestion({ day: "sun", note: "leave early" });
    });

    expect(agent.toolRespond).toHaveBeenCalledWith(
      "q1",
      true,
      'The user submitted the form. Answers: {"day":"sun","note":"leave early"}',
    );
    const items = current.conversation.items;
    expect(items[items.length - 1]).toMatchObject({
      answer: "sun · leave early",
    });
  });

  it("falls back to a plain question when the form uses unknown components", async () => {
    await startRunAndAsk({
      question: "Pick one",
      options: ["A", "B"],
      form: { root: "x", elements: { x: { type: "Script", props: {}, children: [] } } },
    });
    expect(current.pendingQuestion).toMatchObject({ form: null, options: ["A", "B"] });
  });

  it("doesn't revive a stopped run's question in the next run", async () => {
    await startRunAndAsk({ question: "Which day?", options: [], form: null });
    expect(current.pendingQuestion).not.toBeNull();

    await act(async () => {
      await current.stop();
    });
    act(() =>
      mocks.eventHandler?.({
        runId: "run-1",
        event: { type: "done", stopReason: "cancelled" },
      }),
    );
    await settle();
    expect(current.pendingQuestion).toBeNull();

    vi.mocked(agent.startRun).mockResolvedValueOnce({ runId: "run-2" });
    await act(async () => {
      await current.send("Just add a packing list");
    });
    await settle();

    expect(current.conversation.runId).toBe("run-2");
    expect(current.pendingQuestion).toBeNull();
    await act(async () => {
      await current.answerQuestion("Saturday");
    });
    expect(agent.toolRespond).not.toHaveBeenCalled();
  });
});

describe("AgentProvider expressions", () => {
  const focused: agent.AgentExpression = {
    expression: "focused", sentiment: 0.2, intensity: 0.7,
  };
  const pleased: agent.AgentExpression = {
    expression: "pleased", sentiment: 0.8, intensity: 0.5,
  };
  const emit = (event: agent.AgentEvent, runId = "run-1") => {
    act(() => mocks.eventHandler?.({ runId, event }));
  };
  async function begin() {
    act(() => current.toggle());
    await settle();
    await act(async () => { await current.send("Plan the trip"); });
  }

  it("updates live metadata without completing the run, changing its transcript, or answering a question", async () => {
    await startRunAndAsk({ question: "Which day?", options: [], form: null });
    emit({ type: "session", sessionId: "expression-session" });
    const items = current.conversation.items;
    const question = current.pendingQuestion;

    emit({ type: "expression", ...focused });

    expect(current.conversation.expression).toEqual(focused);
    expect(current.conversation.runId).toBe("run-1");
    expect(current.conversation.items).toBe(items);
    expect(current.pendingQuestion).toBe(question);
    expect(agent.toolRespond).not.toHaveBeenCalled();
    expect(agent.saveConversation).not.toHaveBeenCalled();
  });

  it("keeps the final successful expression in memory but never saves or restores it", async () => {
    await begin();
    emit({ type: "session", sessionId: "expression-session" });
    emit({ type: "expression", ...pleased });
    const items = current.conversation.items;
    emit({ type: "done", stopReason: "completed" });
    await settle();

    expect(current.conversation.expression).toEqual(pleased);
    expect(current.conversation.runId).toBeNull();
    expect(agent.saveConversation).toHaveBeenLastCalledWith("expression-session", items);

    vi.mocked(agent.loadConversation).mockResolvedValueOnce([
      ...items,
      { id: "old-expression", type: "expression", ...pleased },
      { id: "old-face-tool", type: "tool", name: "set_expression", input: pleased, ok: true, output: "Updated." },
    ]);
    await act(async () => { await current.openConversation("expression-session"); });
    expect(current.conversation.expression).toBeUndefined();
    expect(current.conversation.items).toEqual(items);
  });

  it("resets on a new run and ignores old expressions both during startup and after it", async () => {
    await begin();
    emit({ type: "expression", ...pleased });
    emit({ type: "done", stopReason: "completed" });
    vi.mocked(agent.startRun).mockImplementationOnce(async () => {
      mocks.eventHandler?.({ runId: "run-1", event: { type: "expression", ...pleased } });
      return { runId: "run-2" };
    });
    await act(async () => { await current.send("Add a packing list"); });
    expect(current.conversation.runId).toBe("run-2");
    expect(current.conversation.expression).toBeUndefined();
    emit({ type: "expression", ...focused }, "run-2");
    emit({ type: "expression", ...pleased });
    expect(current.conversation.expression).toEqual(focused);
    expect(current.conversation.runId).toBe("run-2");
  });

  it("clears immediately on Stop and ignores expressions until cancellation finishes", async () => {
    await begin();
    emit({ type: "expression", ...focused });

    await act(async () => { await current.stop(); });
    expect(current.conversation.expression).toBeUndefined();
    expect(current.conversation.runId).toBe("run-1");
    emit({ type: "expression", ...pleased });
    expect(current.conversation.expression).toBeUndefined();

    // A completion already in flight must not revive a stopped expression.
    emit({ type: "done", stopReason: "completed" });
    emit({ type: "expression", ...pleased });
    expect(current.conversation.expression).toBeUndefined();
    expect(current.conversation.runId).toBeNull();
  });

  it("ignores buffered expressions when Stop was requested before startup finished", async () => {
    act(() => current.toggle());
    await settle();
    await act(async () => {
      const sending = current.send("Plan the trip");
      await current.stop();
      mocks.eventHandler?.({ runId: "run-1", event: { type: "expression", ...focused } });
      await sending;
    });
    expect(agent.cancelRun).toHaveBeenCalledWith("run-1");
    expect(current.conversation.expression).toBeUndefined();
    expect(current.conversation.runId).toBe("run-1");
    emit({ type: "done", stopReason: "cancelled" });
    expect(current.conversation.runId).toBeNull();
  });

  it.each<agent.AgentEvent>([
    { type: "done", stopReason: "cancelled" },
    { type: "error", kind: "other", message: "Connection lost" },
  ])("clears expressions on $type and ignores late expressions", async (terminal) => {
    await begin();
    emit({ type: "expression", ...focused });
    emit(terminal);
    emit({ type: "expression", ...pleased });

    expect(current.conversation.expression).toBeUndefined();
    expect(current.conversation.runId).toBeNull();
    if (terminal.type === "error")
      expect(current.conversation.error?.message).toBe("Connection lost");
    else
      expect(current.conversation.cancelled).toBe(true);
  });

  it("resets the previous expression when an automatic check-in starts", async () => {
    await begin();
    emit({ type: "expression", ...pleased });
    emit({ type: "done", stopReason: "completed" });
    await settle();
    vi.mocked(agent.startRun).mockResolvedValueOnce({ runId: "check-in" });
    vi.useFakeTimers();

    act(() => editor.commands.insertContent("Saturday "));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(current.conversation.runId).toBe("check-in");
    expect(current.conversation.expression).toBeUndefined();
    expect(current.conversation.items[current.conversation.items.length - 1]).toMatchObject({ type: "activity" });
  });

  it("hides expression calls and results without hiding failed document tools", async () => {
    await begin();
    emit({ type: "tool_call", callId: "read", name: "read_document", input: {} });
    const readingItems = current.conversation.items;
    emit({ type: "tool_call", callId: "face", name: "set_expression", input: focused });
    emit({ type: "tool_result", callId: "face", ok: true, output: "Updated." });
    emit({ type: "tool_call", callId: "bad-face", name: "set_expression", input: {} });
    emit({ type: "tool_result", callId: "bad-face", ok: false, output: "Invalid expression." });
    expect(current.conversation.items).toBe(readingItems);
    expect(current.conversation.runId).toBe("run-1");

    emit({ type: "tool_result", callId: "read", ok: false, output: "The document changed." });
    expect(current.conversation.items).toContainEqual(expect.objectContaining({
      type: "tool", name: "read_document", ok: false, output: "The document changed.",
    }));
    expect(current.conversation.items.some((item) => item.type === "tool" && item.name === "set_expression")).toBe(false);
  });
});

describe("AgentProvider conversation history", () => {
  it("drains deferred saves after a heading rename without losing the final diff", async () => {
    act(() => current.toggle());
    await settle();
    await act(async () => { await current.send("Revise the plan"); });
    act(() => mocks.eventHandler?.({
      runId: "run-1", event: { type: "session", sessionId: "stable-session" },
    }));
    let release!: () => void;
    vi.mocked(agent.saveConversation).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const changes = [
      { noteTitle: "Trip plan", hunks: [{ before: ["Friday"], after: ["Saturday"] }] },
      { noteTitle: "Trip plan", hunks: [{ before: ["Trip plan"], after: ["Summer trip"] }] },
    ];
    for (const [index, change] of changes.entries()) {
      vi.mocked(executeDocumentTool).mockResolvedValueOnce({ ok: true, output: "Applied.", change });
      act(() => mocks.toolHandler?.({
        requestId: `edit-${index}`, runId: "run-1", name: "edit_document", args: {},
      }));
      await settle();
    }
    expect(agent.saveConversation).toHaveBeenCalledTimes(1);
    act(() => {
      mocks.currentNote = { ...mocks.currentNote!, id: "Summer trip", title: "Summer trip" };
      editor.storage.scratchDocument.noteId = "Summer trip";
      editor.view.dispatch(editor.state.tr);
      mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } });
      release();
    });
    await settle();
    const calls = vi.mocked(agent.saveConversation).mock.calls;
    expect(calls[calls.length - 1]).toEqual([
      "stable-session",
      expect.arrayContaining(changes.map((change, index) => ({
        id: `edit-${index}:changes`, type: "changes", change,
      }))),
    ]);
  });

  it("saves applied edits before the reply and restores them after an interrupted turn", async () => {
    act(() => current.toggle());
    await settle();
    await act(async () => { await current.send("Change the day"); });
    act(() => mocks.eventHandler?.({
      runId: "run-1", event: { type: "session", sessionId: "saved-turn" },
    }));
    const change = { noteTitle: "Trip plan", hunks: [{ before: ["Friday"], after: ["Saturday"], line: 3 }] };
    vi.mocked(executeDocumentTool).mockResolvedValueOnce({ ok: true, output: "Applied.", change });
    act(() => mocks.toolHandler?.({
      requestId: "edit-request", runId: "run-1", name: "edit_document", args: {},
    }));
    await settle();
    expect(agent.saveConversation).toHaveBeenCalledWith("saved-turn",
      expect.arrayContaining([{ id: "edit-request:changes", type: "changes", change }]));
    act(() => mocks.eventHandler?.({
      runId: "run-1", event: { type: "error", kind: "other", message: "Connection lost" },
    }));
    await settle();
    const calls = vi.mocked(agent.saveConversation).mock.calls;
    const saved = calls[calls.length - 1][1];
    vi.mocked(agent.loadConversation).mockResolvedValueOnce(saved);
    await act(async () => { await current.openConversation("saved-turn"); });
    expect(current.conversation.items).toContainEqual({
      id: "edit-request:changes", type: "changes", change,
    });
  });

  it("restores the note's latest conversation and continues it", async () => {
    vi.mocked(agent.listConversations).mockResolvedValue([
      {
        id: "s-old",
        documentId: "doc-1",
        title: "Plan the trip",
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    vi.mocked(agent.loadConversation).mockResolvedValue([
      { id: "u1", type: "user", text: "Plan the trip" },
      { id: "x1", type: "from-a-newer-version" },
    ]);

    act(() => current.toggle());
    await settle();
    expect(agent.loadConversation).toHaveBeenCalledWith("trip", "s-old");
    expect(current.history.map((entry) => entry.id)).toEqual(["s-old"]);
    expect(current.conversation.sessionId).toBe("s-old");
    expect(current.conversation.items).toEqual([
      { id: "u1", type: "user", text: "Plan the trip" },
    ]);

    await act(async () => {
      await current.send("Now the budget");
    });
    expect(vi.mocked(agent.startRun).mock.calls[0][0].sessionId).toBe("s-old");

    act(() =>
      mocks.eventHandler?.({
        runId: "run-1",
        event: { type: "done", stopReason: "completed" },
      }),
    );
    await settle();
    const [sessionId, items] = vi.mocked(agent.saveConversation).mock.calls[0];
    expect(sessionId).toBe("s-old");
    expect(items.map((item) => (item as { text?: string }).text)).toEqual([
      "Plan the trip",
      "Now the budget",
    ]);
  });
});

describe("AgentProvider coediting", () => {
  async function begin() {
    act(() => current.toggle());
    await settle();
    await act(async () => { await current.send("Plan the trip"); });
  }
  async function complete() {
    act(() => mocks.eventHandler?.({
      runId: "run-1", event: { type: "done", stopReason: "completed" },
    }));
    await settle();
  }
  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it("persists disabled computer access and honors it after reopening", async () => {
    act(() => current.toggle());
    await settle();
    act(() => current.setComputerAccess(false));
    await settle();
    expect(notes.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ agentComputerAccess: false }));
    const saved = { ...await notes.getSettings(), agentComputerAccess: false };
    vi.mocked(notes.getSettings).mockResolvedValueOnce(saved);
    act(() => root.unmount());
    root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(<AgentProvider editorRef={{ current: editor }} editor={editor}><Probe /></AgentProvider>);
    });
    act(() => current.toggle());
    await settle();
    await act(async () => { await current.send("Read this note"); });
    expect(vi.mocked(agent.startRun).mock.calls[0][0].computerAccess).toBe(false);
  });

  it("logs direct cross-note edits without waiting for approval", async () => {
    await begin();
    act(() => {
      mocks.eventHandler?.({ runId: "run-1", event: {
        type: "tool_call", callId: "edit-1", name: "edit_note",
        input: { id: "Packing tips", edits: [{ old_text: "jacket", new_text: "coat" }] },
      } });
      mocks.eventHandler?.({ runId: "run-1", event: {
        type: "tool_result", callId: "edit-1", ok: true, output: "Saved Packing tips",
      } });
    });
    expect(current.conversation.items).toContainEqual(expect.objectContaining({
      type: "tool", name: "edit_note", ok: true, output: "Saved Packing tips",
    }));
    expect(current.conversation.items[current.conversation.items.length - 1]).toMatchObject({
      type: "changes",
      change: { noteTitle: "Packing tips", hunks: [{ before: ["jacket"], after: ["coat"] }] },
    });
    act(() => {
      mocks.eventHandler?.({ runId: "run-1", event: {
        type: "tool_call", callId: "failed-edit", name: "edit_note",
        input: { id: "Packing tips", edits: [{ old_text: "coat", new_text: "parka" }] },
      } });
      mocks.eventHandler?.({ runId: "run-1", event: {
        type: "tool_result", callId: "failed-edit", ok: false, output: "File changed on disk",
      } });
    });
    expect(current.conversation.items.filter((item) => item.type === "changes")).toHaveLength(1);
    expect(agent.toolRespond).not.toHaveBeenCalled();
  });

  it("debounces local edits, ignores agent changes, and pauses future check-ins", async () => {
    await begin();
    expect(vi.mocked(agent.startRun).mock.calls[0][0].computerAccess).toBe(true);
    await complete();
    vi.useFakeTimers();
    act(() => editor.view.dispatch(setChangeMeta(editor.state.tr.insertText("Agent "), { source: "agent" })));
    await advance(12000);
    expect(agent.startRun).toHaveBeenCalledTimes(1);
    act(() => editor.commands.insertContent("Walking "));
    await advance(1500);
    act(() => editor.commands.insertContent("Saturday "));
    await advance(1999);
    expect(agent.startRun).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(agent.startRun).toHaveBeenCalledTimes(2);
    expect(current.conversation.items[current.conversation.items.length - 1]).toMatchObject({ type: "activity" });
    await complete();
    act(() => editor.commands.insertContent("More "));
    await act(async () => { await current.stop(); });
    await advance(20000);
    expect(agent.startRun).toHaveBeenCalledTimes(2);
    expect(current.coediting).toBe(false);
  });

  it("queues user edits during a run without starting concurrent turns", async () => {
    await begin();
    vi.useFakeTimers();
    act(() => editor.commands.insertContent("Coastal "));
    await advance(3000);
    expect(agent.startRun).toHaveBeenCalledTimes(1);
    await complete();
    await advance(1);
    expect(agent.startRun).toHaveBeenCalledTimes(2);
    await complete();
    act(() => editor.commands.insertContent("path "));
    await advance(2000);
    expect(agent.startRun).toHaveBeenCalledTimes(2);
    await advance(8000);
    expect(agent.startRun).toHaveBeenCalledTimes(3);
  });

  it("notifies a waiting question of document edits without inventing an answer", async () => {
    await startRunAndAsk({ question: "Where?", options: [], form: null });
    vi.useFakeTimers();
    act(() => editor.commands.insertContent("Destination: Bath. "));
    await advance(2000);
    expect(agent.toolRespond).toHaveBeenCalledWith("q1", true, expect.stringContaining("This is not an answer"));
    expect(current.pendingQuestion).toBeNull();
    expect(agent.startRun).toHaveBeenCalledTimes(1);
  });

  it("drops a pending check-in when the document is replaced", async () => {
    await begin();
    await complete();
    vi.useFakeTimers();
    act(() => {
      editor.commands.insertContent("Queued ");
      editor.storage.scratchDocument.session++;
      editor.view.dispatch(setChangeMeta(editor.state.tr, { clear: true }));
      editor.commands.setContent("<p>Another note</p>");
    });
    await advance(20000);
    expect(agent.startRun).toHaveBeenCalledTimes(1);
  });
});

describe("AgentProvider research and skill offers", () => {
  const offer = {
    type: "skill_offer" as const,
    name: "trip-planning",
    description: "Plan trips day by day.",
    source: "https://docs.example.com/.well-known/agent-skills/trip-planning/SKILL.md",
    content: "---\nname: trip-planning\ndescription: Plan trips day by day.\n---\n",
    files: [],
    digest: `sha256:${"a".repeat(64)}`,
    archive: false,
  };
  const finish = async () => {
    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } }));
    await settle();
  };

  it("runs research on Luna until the user picks a model, and not at all with internet access off", async () => {
    vi.mocked(agent.listModels).mockResolvedValue([
      { id: "gpt-x", label: "GPT X" },
      { id: "gpt-6-luna", label: "GPT-6-Luna" },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
    ]);
    act(() => current.toggle());
    await settle();
    expect(current.researchModel).toBe("gpt-6-luna");
    await act(async () => { await current.send("How do rail passes work?"); });
    expect(vi.mocked(agent.startRun).mock.calls[0][0]).toMatchObject({
      model: "gpt-x", webAccess: true, researchModel: "gpt-6-luna", researchBrief: null,
    });
    await finish();

    act(() => {
      current.setResearchModel("gpt-x");
      current.setResearchBrief("  Only official documentation.  ");
      current.setWebAccess(false);
    });
    await settle();
    expect(notes.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ agentWebAccess: false }));
    await act(async () => { await current.send("And night trains?"); });
    expect(vi.mocked(agent.startRun).mock.calls[1][0]).toMatchObject({
      webAccess: false, researchModel: "gpt-x", researchBrief: "Only official documentation.",
    });
  });

  it("shows one card per version of an offered skill and remembers a dismissal", async () => {
    act(() => current.toggle());
    await settle();
    await act(async () => { await current.send("Plan the trip"); });
    act(() => {
      mocks.eventHandler?.({ runId: "run-1", event: { type: "session", sessionId: "s-1" } });
      mocks.eventHandler?.({ runId: "run-1", event: offer });
      mocks.eventHandler?.({ runId: "run-1", event: offer });
      mocks.eventHandler?.({ runId: "run-1", event: {
        ...offer, content: `${offer.content}\nStart with dates.\n`, digest: `sha256:${"b".repeat(64)}`,
      } });
      // An archive whose bundled files changed: same address and instructions, new download.
      mocks.eventHandler?.({ runId: "run-1", event: { ...offer, digest: `sha256:${"c".repeat(64)}` } });
    });
    await settle();
    const cards = current.conversation.items.filter((item) => item.type === "skill_offer");
    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({ name: "trip-planning", source: offer.source, content: offer.content });

    act(() => current.dismissSkillOffer(cards[0].id));
    await settle();
    const saves = vi.mocked(agent.saveConversation).mock.calls;
    const saved = saves[saves.length - 1][1] as Array<Record<string, unknown>>;
    expect(saved.filter((item) => item.type === "skill_offer").map((item) => item.dismissed)).toEqual([true, undefined, undefined]);
  });

  it("drops a saved offer card it couldn't show instead of failing on it", async () => {
    const { type: _type, ...fields } = offer;
    vi.mocked(agent.listConversations).mockResolvedValue([
      { id: "s-old", documentId: "d1", title: "Trip", createdAt: 1, updatedAt: 2 },
    ]);
    vi.mocked(agent.loadConversation).mockResolvedValue([
      { id: "o1", type: "skill_offer", name: "half-saved", source: offer.source },
      { id: "o2", type: "skill_offer", ...fields },
    ]);
    act(() => current.toggle());
    await settle();
    expect(current.conversation.items.map((item) => item.id)).toEqual(["o2"]);
  });
});

describe("writing companion", () => {
  async function ready() {
    await act(async () => { await current.refreshStatus(); });
    await settle();
  }
  async function finish(text = "This claim needs a source before the conclusion follows.") {
    act(() => {
      if (text) mocks.eventHandler?.({ runId: "run-1", event: { type: "text_delta", text } });
      mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } });
    });
    await settle();
  }
  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it("uses only the cheap gate for clean writing and reuses an unchanged passage", async () => {
    await ready();
    await act(async () => { await current.startCompanion(); });
    expect(current.open).toBe(false);
    expect(current.companionActive).toBe(true);
    expect(agent.reviewWriting).toHaveBeenCalledOnce();
    expect(agent.startRun).not.toHaveBeenCalled();
    await act(async () => { await current.stop(); await current.startCompanion(); });
    expect(agent.reviewWriting).toHaveBeenCalledOnce();
    expect(current.writingFocus).toBeNull();
    expect(current.writingSuggestion).toBeNull();
  });

  it("grounds a concern, generates one read-only suggestion, and keeps it out of the transcript", async () => {
    await ready();
    vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: "evidence", anchor: 0, route: "fast" });
    await act(async () => { await current.startCompanion(); });
    expect(current.open).toBe(false);
    expect(current.writingFocus).toBe("evidence");
    expect(current.writingTarget).toEqual({ from: 0, to: editor.state.doc.firstChild!.nodeSize });
    expect(agent.startRun).toHaveBeenCalledWith(expect.objectContaining({
      readOnly: true, computerAccess: false, webAccess: true, sessionId: null,
    }));
    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "session", sessionId: "ephemeral" } }));
    await finish();
    expect(current.writingSuggestion?.text).toContain("needs a source");
    expect(current.conversation.items).toEqual([]);
    expect(current.conversation.sessionId).toBeNull();
    expect(agent.saveConversation).not.toHaveBeenCalled();
    act(() => { current.focusPanel(); current.close(); });
    expect(current.companionActive).toBe(true);
    expect(agent.cancelRun).not.toHaveBeenCalled();
    act(() => current.dismissWritingSuggestion());
    expect(current.writingFocus).toBeNull();
    expect(current.writingTarget).toBeNull();
    expect(current.writingSuggestion).toBeNull();
    vi.useFakeTimers();
    act(() => editor.commands.insertContent("New idea "));
    await advance(5000);
    expect(agent.reviewWriting).toHaveBeenLastCalledWith(expect.objectContaining({ dismissed: [expect.stringContaining("needs a source")] }));
  });

  it("checks after writing pauses with the sidebar closed, and limits repeat requests", async () => {
    await ready();
    await act(async () => { await current.startCompanion(); });
    vi.useFakeTimers();
    act(() => editor.commands.insertContent("First "));
    await advance(4000);
    act(() => editor.commands.insertContent("Second "));
    await advance(4999);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(2);
    act(() => editor.commands.insertContent("Third "));
    await advance(5000);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(2);
    await advance(25000);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(3);
    act(() => editor.view.dispatch(setChangeMeta(editor.state.tr.insertText("Agent "), { source: "agent" })));
    await advance(40000);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(3);
    await act(async () => { await current.stop(); });
    act(() => editor.commands.insertContent("Paused "));
    await advance(40000);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(3);
  });

  it.each(["edit", "pause"])("ignores an assessment after %s", async (action) => {
    await ready();
    let resolve!: (value: { focus: "clarity"; anchor: number; route: "fast" }) => void;
    vi.mocked(agent.reviewWriting).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    let pending!: Promise<void>;
    act(() => { pending = current.startCompanion(); });
    if (action === "edit") act(() => editor.commands.insertContent("Changed "));
    else await act(async () => { await current.stop(); });
    await act(async () => { resolve({ focus: "clarity", anchor: 0, route: "fast" }); await pending; });
    expect(agent.startRun).not.toHaveBeenCalled();
    expect(current.writingFocus).toBeNull();
    expect(current.writingTarget).toBeNull();
  });

  it("discards a generated suggestion when the reviewed text changes", async () => {
    await ready();
    vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: "clarity", anchor: 0, route: "fast" });
    await act(async () => { await current.startCompanion(); });
    act(() => editor.commands.insertContent("Revised "));
    await finish();
    expect(current.writingSuggestion).toBeNull();
    expect(current.writingTarget).toBeNull();
    expect(current.writingFocus).toBeNull();
  });

  it("keeps following the current draft when a check on older text fails", async () => {
    await ready();
    let fail!: (reason: Error) => void;
    vi.mocked(agent.reviewWriting).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    let pending!: Promise<void>;
    act(() => { pending = current.startCompanion(); });
    act(() => editor.commands.insertContent("Revised "));
    await act(async () => { fail(new Error("Offline")); await pending; });
    expect(current.conversation.error).toBeNull();
    expect(current.companionActive).toBe(true);
  });

  it("does not turn an API failure into criticism or an expensive fallback", async () => {
    await ready();
    vi.mocked(agent.reviewWriting).mockRejectedValueOnce(new Error("Offline"));
    await act(async () => { await current.startCompanion(); });
    expect(current.conversation.error?.message).toContain("Offline");
    expect(current.conversation.error?.kind).toBe("writing_review");
    expect(current.companionActive).toBe(false);
    expect(current.writingFocus).toBeNull();
    expect(agent.startRun).not.toHaveBeenCalled();
    await act(async () => { await current.startCompanion(); });
    expect(agent.reviewWriting).toHaveBeenCalledTimes(2);
    expect(current.conversation.error).toBeNull();
    expect(current.conversation.items).toEqual([]);
    expect(current.companionActive).toBe(true);
  });

  it("keeps explicit requests on the normal agent path and guards background edits", async () => {
    await ready();
    await act(async () => { await current.send("Please tighten this paragraph", false, "companion"); });
    expect(agent.reviewWriting).not.toHaveBeenCalled();
    expect(agent.startRun).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: false, prompt: "Please tighten this paragraph" }));
    await finish("Tightened the paragraph.");
    vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: "clarity", anchor: 0, route: "fast" });
    await act(async () => { await current.startCompanion(); });
    await act(async () => { await mocks.toolHandler?.({ runId: "run-1", requestId: "forbidden", name: "edit_document", args: { edits: [] } }); });
    expect(executeDocumentTool).not.toHaveBeenCalled();
    expect(agent.toolRespond).toHaveBeenCalledWith("forbidden", false, expect.stringContaining("only read"));
  });
});

it("retries a failed writing suggestion on unchanged text", async () => {
  await act(async () => { await current.refreshStatus(); });
  await settle();
  vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: "clarity", anchor: 0, route: "fast" });
  vi.mocked(agent.startRun).mockRejectedValueOnce(new Error("Temporary failure"));
  await act(async () => { await current.startCompanion(); });
  expect(current.writingFocus).toBeNull();
  expect(current.conversation.error?.message).toContain("Temporary failure");
  await act(async () => { await current.startCompanion(); });
  expect(agent.reviewWriting).toHaveBeenCalledTimes(2);
  expect(agent.startRun).toHaveBeenCalledTimes(2);
  expect(current.writingFocus).toBe("clarity");
});

it.each(["assessment", "generation"])("lets an explicit request preempt background %s", async (stage) => {
  await act(async () => { await current.refreshStatus(); });
  await settle();
  let resolve!: (value: { focus: "clarity"; anchor: number; route: "fast" }) => void;
  if (stage === "assessment") vi.mocked(agent.reviewWriting).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  else vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: "clarity", anchor: 0, route: "fast" });
  let background!: Promise<void>;
  await act(async () => { background = current.startCompanion(); });
  act(() => current.prepareCompanionMessage());
  if (stage === "assessment") await act(async () => { resolve({ focus: "clarity", anchor: 0, route: "fast" }); await background; });
  vi.mocked(agent.startRun).mockResolvedValueOnce({ runId: "foreground" });
  await act(async () => { expect(await current.send("Please help me write this", false, "companion")).toBe(true); });
  expect(current.conversation.runId).toBe("foreground");
  expect(agent.startRun).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: false, prompt: "Please help me write this" }));
  if (stage === "generation") expect(agent.cancelRun).toHaveBeenCalledWith("run-1");
  expect(current.writingFocus).toBeNull();
});

it("remembers delivered advice after unrelated typing so it does not nag", async () => {
  await act(async () => { await current.refreshStatus(); });
  await settle();
  vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: "clarity", anchor: 0, route: "fast" });
  await act(async () => { await current.startCompanion(); });
  act(() => {
    mocks.eventHandler?.({ runId: "run-1", event: { type: "text_delta", text: "Explain which route you mean." } });
    mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } });
  });
  vi.useFakeTimers();
  act(() => editor.commands.insertContent("Another thought. "));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(agent.reviewWriting).toHaveBeenLastCalledWith(expect.objectContaining({ dismissed: ["Explain which route you mean."] }));
});

describe("structured writing offers", () => {
  const offer = {
    kind: "rewrite", quote: "Trip plan", explanation: "Give the opening a clearer direction.",
    replacement: "A quieter trip", question: null, destination: null, trace: [], sources: [],
  };
  async function readyWithModels() {
    vi.mocked(agent.listModels).mockResolvedValue([
      { id: "gpt-x", label: "GPT X" }, { id: "gpt-6-luna", label: "Luna" },
    ]);
    act(() => current.reloadModels());
    await act(async () => { await current.refreshStatus(); });
    await settle();
  }
  async function deliver(args = offer) {
    await act(async () => { await mocks.toolHandler?.({ runId: "run-1", requestId: "offer-1", name: "offer_writing_help", args }); });
    expect(current.writingOffer).toBeNull();
    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } }));
    await settle();
  }
  it("routes simple proposals to Luna and applies only on explicit acceptance", async () => {
    await readyWithModels();
    await act(async () => { await current.requestWritingHelp("rewrite"); });
    expect(agent.classifyInlineContext).toHaveBeenCalledOnce();
    expect(agent.startRun).toHaveBeenLastCalledWith(expect.objectContaining({
      model: "gpt-6-luna", readOnly: true, sessionId: null, webAccess: false, computerAccess: false,
    }));
    await deliver();
    expect(current.writingOffer?.prepared.offer).toEqual(offer);
    expect(current.writingOfferDraft).toBe("A quieter trip");
    expect(editor.getText()).toBe("Trip plan");
    expect(current.conversation.items).toEqual([]);
    act(() => current.acceptWritingOffer("A thoughtful trip"));
    expect(editor.getText()).toBe("A thoughtful trip");
    expect(current.writingOffer).toBeNull();
    act(() => editor.commands.undo());
    expect(editor.getText()).toBe("Trip plan");
  });
  it("uses the selected model for heavy work and the same model for delegated research", async () => {
    await readyWithModels();
    act(() => { current.setModel("gpt-x"); current.setWebAccess(true); });
    vi.mocked(agent.classifyInlineContext).mockResolvedValueOnce({ intent: "research", confidence: 0.98, route: "deep" });
    await act(async () => { await current.requestWritingHelp("evidence"); });
    expect(agent.startRun).toHaveBeenLastCalledWith(expect.objectContaining({ model: "gpt-x", researchModel: "gpt-x", webAccess: true, readOnly: true }));
  });
  it("marks an offer stale when its passage changes and prevents acceptance", async () => {
    await readyWithModels();
    await act(async () => { await current.requestWritingHelp("rewrite"); });
    await deliver();
    act(() => editor.commands.setContent("<p>A different thought</p>"));
    expect(current.writingOffer?.stale).toBe(true);
    act(() => current.acceptWritingOffer());
    expect(editor.getText()).toBe("A different thought");
  });
  it("rejects invented anchors before a card can become actionable", async () => {
    await readyWithModels();
    await act(async () => { await current.requestWritingHelp("rewrite"); });
    await deliver({ ...offer, quote: "Not in this note" });
    expect(agent.toolRespond).toHaveBeenCalledWith("offer-1", false, expect.any(String));
    expect(current.writingOffer).toBeNull();
  });
  it("discards a prepared offer if the passage changes before completion", async () => {
    await readyWithModels();
    await act(async () => { await current.requestWritingHelp("rewrite"); });
    await act(async () => { await mocks.toolHandler?.({ runId: "run-1", requestId: "offer-1", name: "offer_writing_help", args: offer }); });
    act(() => editor.commands.setContent("<p>Changed while working</p>"));
    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } }));
    expect(current.writingOffer).toBeNull();
    expect(current.writingSuggestion).toBeNull();
  });
});

it("coalesces repeated explicit offer requests while the classifier is pending", async () => {
  await act(async () => { await current.refreshStatus(); });
  await settle();
  let resolve!: (value: agent.InlineDecision) => void;
  vi.mocked(agent.classifyInlineContext).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  let first!: Promise<void>;
  act(() => { first = current.requestWritingHelp("question"); });
  await act(async () => { await current.requestWritingHelp("question"); });
  expect(agent.classifyInlineContext).toHaveBeenCalledOnce();
  expect(agent.startRun).not.toHaveBeenCalled();
  await act(async () => { resolve({ intent: "suggest", confidence: .95, route: "fast" }); await first; });
  expect(agent.startRun).toHaveBeenCalledOnce();
});
