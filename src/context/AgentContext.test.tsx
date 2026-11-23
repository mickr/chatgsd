// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ScratchDocument, setChangeMeta } from "../components/editor/AgentChanges";
import { ArgumentMap } from "../components/editor/ArgumentMap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "../services/agent";
import * as notes from "../services/notes";
import type { Note } from "../types/note";
import { executeDocumentTool } from "../lib/agent/documentTools";
import { AgentPanel } from "../components/agent/AgentPanel";
import { TooltipProvider } from "../components/ui";
import { toast } from "sonner";
import type { TraceRecord } from "../lib/agent/traceRecord";
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
  returnThought: vi.fn(async () => {}),
  forgetMemory: vi.fn(async () => {}),
  recordTraceMemory: vi.fn(async () => {}),
  beginConversation: vi.fn(async () => "session-traced"),
  getNoteMemory: vi.fn(async () => ({ documentId: "test-document", revision: 0, entries: [] })),
  classifyInlineContext: vi.fn(),
  toolRespond: vi.fn(() => Promise.resolve()),
  steerRun: vi.fn(() => Promise.resolve()),
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
vi.mock("./SkillsContext", () => ({
  useSkills: () => ({ skills: [] }),
}));
vi.mock("./McpContext", () => ({
  useMcp: () => ({ servers: [], error: null, refresh: vi.fn() }),
}));
vi.mock("../services/notes", () => ({
  getSettings: vi.fn(() => Promise.resolve({})),
  updateSettings: vi.fn(() => Promise.resolve()),
}));
vi.mock("./NotesContext", () => ({
  useOptionalNotes: () => ({
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

/**
 * Open the panel and let the note's starters run come and go, as it does before
 * anything else. Leaves real timers and a clean record of started runs.
 */
async function openPanel(starters = "") {
  vi.useFakeTimers();
  act(() => current.toggle());
  await settle();
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  act(() => {
    if (starters) mocks.eventHandler?.({ runId: "run-1", event: { type: "text_delta", text: starters } });
    mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } });
  });
  await settle();
  vi.mocked(agent.startRun).mockClear();
  vi.useRealTimers();
}

async function startRunAndAsk(args: Record<string, unknown>, name = "ask_user") {
  act(() => current.toggle());
  await settle();
  await act(async () => {
    await current.send("Plan the trip");
  });
  act(() =>
    mocks.toolHandler?.({
      requestId: "q1",
      runId: "run-1",
      name,
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
  editor = new Editor({ extensions: [StarterKit, ScratchDocument, ArgumentMap], content: "<p>Trip plan</p>" });
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
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
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

it("forgets a saved item by revision without editing", async () => {
  act(() => current.toggle());
  await settle();
  const draft = editor.state.doc;
  await act(async () => { await current.forgetMemory("costs"); });
  expect(agent.forgetMemory).toHaveBeenCalledWith("/notes", "test-document", READY.account!.email, 0, "costs");
  expect(editor.state.doc.eq(draft)).toBe(true);
  expect(agent.startRun).not.toHaveBeenCalled();
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

  it("asks before an MCP tool runs and returns the user's choice to the waiting call", async () => {
    await startRunAndAsk({
      question: "Allow Tracker to run create_issue?",
      options: ["Create ticket", "Always allow", "Don't allow"],
      form: null,
      call: { server: "Tracker", tool: "create_issue", arguments: { title: "Book the ferry" } },
      preview: {
        root: "ticket",
        elements: { ticket: { type: "Card", props: { title: "Book the ferry" }, children: [] } },
      },
    }, "mcp_approval");

    expect(current.pendingQuestion).toMatchObject({
      question: "Allow Tracker to run create_issue?",
      options: ["Create ticket", "Always allow", "Don't allow"],
      form: null,
      preview: {
        root: "approval",
        elements: {
          approval: { children: ["preview/ticket", "call"] },
          "call/0": { type: "KeyValue", props: { items: [{ label: "title", value: "Book the ferry" }] } },
        },
      },
    });
    await act(async () => {
      await current.answerQuestion("Always allow");
    });
    expect(agent.toolRespond).toHaveBeenCalledWith("q1", true, "The user answered: Always allow");
    expect(current.pendingQuestion).toBeNull();
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
    vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: null, anchor: null, route: "fast", request: "continue" });
    vi.useFakeTimers();

    act(() => editor.commands.insertContent("Saturday "));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(current.conversation.runId).toBe("check-in");
    expect(current.conversation.expression).toBeUndefined();
    expect(current.conversation.items[current.conversation.items.length - 1]).toMatchObject({ type: "activity" });

    // A check-in with nothing to add leaves no "Checking in" line in the conversation.
    emit({ type: "done", stopReason: "completed" }, "check-in");
    expect(current.conversation.items.some((item) => item.type === "activity")).toBe(false);
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
  // The cheap gate decides whether an edit continues the open request; here it always does.
  beforeEach(() => {
    vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: null, anchor: null, route: "fast", request: "continue" });
  });
  async function begin() {
    await openPanel();
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
    await advance(500);
    act(() => editor.commands.insertContent("Saturday "));
    await advance(999);
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

  it("asks the cheap gate before every continuation and runs nothing when the edit does not call for one", async () => {
    vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: null, anchor: null, route: "fast", request: "open" });
    await begin();
    await complete();
    expect(current.openRequest).toBe(true);
    vi.useFakeTimers();
    act(() => editor.commands.insertContent("Walking "));
    await advance(2000);
    expect(agent.reviewWriting).toHaveBeenLastCalledWith(expect.objectContaining({ openRequest: true }));
    expect(agent.startRun).toHaveBeenCalledTimes(1);
    expect(current.openRequest).toBe(true);
  });

  it("closes a finished request and falls back to the slower offer cadence", async () => {
    vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: null, anchor: null, route: "fast", request: "done" });
    await begin();
    await complete();
    vi.useFakeTimers();
    // Opening the panel took its one look at the whole note.
    expect(agent.reviewWriting).toHaveBeenCalledTimes(1);
    act(() => editor.commands.insertContent("Walking "));
    await advance(2000);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(2);
    expect(current.openRequest).toBe(false);
    expect(current.coediting).toBe(true);
    act(() => editor.commands.insertContent("Saturday "));
    await advance(3000);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(2);
    await advance(3000);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(3);
    expect(agent.reviewWriting).toHaveBeenLastCalledWith(expect.objectContaining({ openRequest: false }));
    expect(agent.startRun).toHaveBeenCalledTimes(1);
  });

  it("leaves a question or suggestion request closed so later edits only bring offers", async () => {
    act(() => current.toggle());
    await settle();
    await act(async () => { await current.send("What do you think of this?", undefined, "coedit", { openRequest: false }); });
    await complete();
    expect(current.coediting).toBe(true);
    expect(current.openRequest).toBe(false);
  });

  it("keeps following from the launcher after the panel closes, and stops on Pause", async () => {
    act(() => current.toggle());
    await settle();
    expect(current.coediting).toBe(true);
    act(() => current.close());
    expect(current.coediting).toBe(true);
    expect(agent.cancelRun).not.toHaveBeenCalled();
    await act(async () => { await current.stop(); });
    expect(current.coediting).toBe(false);
    act(() => current.focusPanel());
    expect(current.coediting).toBe(false);
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

describe("first look and moving around", () => {
  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }
  it("reads the whole note once when the panel opens, without waiting for an edit", async () => {
    await openPanel();
    expect(agent.reviewWriting).toHaveBeenCalledOnce();
    expect(agent.reviewWriting).toHaveBeenCalledWith(expect.objectContaining({ passage: "[p0] Trip plan", openRequest: false }));
    act(() => current.close());
    act(() => current.focusPanel());
    await settle();
    expect(agent.reviewWriting).toHaveBeenCalledOnce();
    expect(agent.startRun).not.toHaveBeenCalled();
  });
  const reply = (text: string) => {
    act(() => {
      mocks.eventHandler?.({ runId: "run-1", event: { type: "text_delta", text } });
      mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } });
    });
    return settle();
  };
  it("writes this note's starters before anything else, in one turn on the fast model, and says nothing", async () => {
    vi.mocked(agent.listModels).mockResolvedValue([{ id: "gpt-x", label: "GPT X" }, { id: "gpt-6-luna", label: "Luna" }]);
    act(() => current.reloadModels());
    await settle();
    vi.useFakeTimers();
    act(() => current.toggle());
    await settle();
    await advance(799);
    expect(agent.startRun).not.toHaveBeenCalled();
    await advance(1);
    expect(agent.startRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ readOnly: true, model: "gpt-6-luna", sessionId: null }));
    // The note is in the request, so the model has nothing to fetch.
    expect(vi.mocked(agent.startRun).mock.calls[0][0].prompt).toContain("[p0] Trip plan");
    expect(agent.reviewWriting).not.toHaveBeenCalled();
    await reply("Starters:\nPick the walking route\nBudget the train fare\nList what to pack");
    expect(current.writingStarters).toEqual(["Pick the walking route", "Budget the train fare", "List what to pack"]);
    expect(current.writingSuggestion).toBeNull();
    expect(current.conversation.items).toEqual([]);
    // Then its one look at the whole note, and no more starter runs however long the writer stays.
    expect(agent.reviewWriting).toHaveBeenCalledOnce();
    act(() => editor.commands.insertContent("More "));
    await advance(20000);
    expect(agent.startRun).toHaveBeenCalledOnce();
  });
  it("lets a message go first and writes the starters after its reply", async () => {
    vi.useFakeTimers();
    act(() => current.toggle());
    await settle();
    await advance(500);
    await act(async () => { await current.send("What do you think?", undefined, "coedit", { openRequest: false }); });
    await advance(10000);
    expect(agent.startRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ readOnly: false }));
    await reply("It reads well.");
    await advance(800);
    expect(agent.startRun).toHaveBeenCalledTimes(2);
    expect(agent.startRun).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true }));
  });
  it("shows a note's last starters at once when the writer returns to it", async () => {
    await openPanel("Starters:\nPick the walking route\nBudget the train fare");
    expect(current.writingStarters).toEqual(["Pick the walking route", "Budget the train fare"]);
    // The same note loaded again is a new document session with nothing written for it yet.
    act(() => { editor.storage.scratchDocument.session++; current.close(); });
    expect(current.writingStarters).toEqual(["Pick the walking route", "Budget the train fare"]);
  });
  it("asks once more for starters alone when neither the first run nor a check-in brought any", async () => {
    vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: "evidence", anchor: 0, route: "fast" });
    await openPanel();
    // The first look raised a concern, so its observation run is already under way.
    vi.useFakeTimers();
    await reply("This claim needs a source.");
    expect(current.writingSuggestion?.text).toBe("This claim needs a source.");
    expect(current.writingStarters).toEqual([]);
    await advance(800);
    expect(agent.startRun).toHaveBeenCalledOnce();
    expect(vi.mocked(agent.startRun).mock.calls[0][0].prompt).toContain("starters only");
    // A second silence is accepted: the standing starters stay.
    await reply("");
    await advance(60000);
    expect(agent.startRun).toHaveBeenCalledOnce();
  });
  it("keeps the starters out of an observation that arrives with them", async () => {
    vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: "evidence", anchor: 0, route: "fast" });
    await openPanel();
    await reply("This claim needs a source.\n\nStarters:\nFind a source\nCut the claim");
    expect(current.writingSuggestion?.text).toBe("This claim needs a source.");
    expect(current.writingStarters).toEqual(["Find a source", "Cut the claim"]);
  });
  it("samples a long note from start to finish, then looks again where the writer moves to", async () => {
    const paragraphs = Array.from({ length: 60 }, (_, index) => `<p>Paragraph ${index} ${"word ".repeat(80)}</p>`).join("");
    act(() => editor.commands.setContent(paragraphs));
    await openPanel();
    const opening = vi.mocked(agent.reviewWriting).mock.calls[0][0];
    expect(opening.paragraphCount).toBe(24);
    expect(opening.passage).toContain("[p0] Paragraph 0 ");
    expect(opening.passage).toContain("[p23] Paragraph 57 ");
    expect(opening.passage.length).toBeLessThanOrEqual(6000);
    vi.useFakeTimers();
    act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1));
    await advance(1499);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(2);
    expect(vi.mocked(agent.reviewWriting).mock.calls[1][0].passage).toContain("Paragraph 59 ");
    // Staying put costs nothing more.
    await advance(60000);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(2);
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
    expect(current.coediting).toBe(true);
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
    expect(current.companionChecking).toBe(true);
    expect(current.companionRequested).toBe(false);
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
    expect(current.coediting).toBe(true);
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
    await advance(1000);
    act(() => editor.commands.insertContent("Second "));
    await advance(1499);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(2);
    act(() => editor.commands.insertContent("Third "));
    await advance(3000);
    expect(agent.reviewWriting).toHaveBeenCalledTimes(2);
    await advance(12000);
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
    expect(current.coediting).toBe(true);
  });

  it("does not turn an API failure into criticism or an expensive fallback", async () => {
    await ready();
    vi.mocked(agent.reviewWriting).mockRejectedValueOnce(new Error("Offline"));
    await act(async () => { await current.startCompanion(); });
    expect(current.conversation.error?.message).toContain("Offline");
    expect(current.conversation.error?.kind).toBe("writing_review");
    expect(current.coediting).toBe(false);
    expect(current.writingFocus).toBeNull();
    expect(agent.startRun).not.toHaveBeenCalled();
    await act(async () => { await current.startCompanion(); });
    expect(agent.reviewWriting).toHaveBeenCalledTimes(2);
    expect(current.conversation.error).toBeNull();
    expect(current.conversation.items).toEqual([]);
    expect(current.coediting).toBe(true);
  });

  it("keeps explicit requests on the normal agent path and guards background edits", async () => {
    await ready();
    await act(async () => { await current.send("Please tighten this paragraph", false, "companion"); });
    expect(agent.reviewWriting).not.toHaveBeenCalled();
    expect(agent.startRun).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: false, prompt: "Please tighten this paragraph" }));
    // Once the reply lands, the agent turns to the note on its own, and only to read it.
    vi.useFakeTimers();
    await finish("Tightened the paragraph.");
    await advance(800);
    expect(agent.startRun).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true }));
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
  async function deliver(args: Record<string, unknown> = offer) {
    await act(async () => { await mocks.toolHandler?.({ runId: "run-1", requestId: "offer-1", name: "offer_writing_help", args }); });
    expect(current.writingOffer).toBeNull();
    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } }));
    await settle();
  }
  it("returns a promised thought on clear prose only after publishing a grounded offer", async () => {
    const memory: agent.NoteMemory = { documentId: "my-trip", revision: 6, entries: [{
      key: "opening", kind: "thought", status: "waiting", quote: "Trip plan",
      summary: "Bring back a quieter opening", next: null,
    }] };
    vi.mocked(agent.getNoteMemory).mockResolvedValueOnce(memory);
    vi.mocked(agent.reviewWriting).mockResolvedValueOnce({ revisit: true, focus: null, anchor: null, route: "fast" });
    await readyWithModels();
    await act(async () => { await current.startCompanion(); });
    expect(agent.startRun).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true, computerAccess: false }));
    expect(current.writingTarget).toBeNull();
    await act(async () => { await mocks.toolHandler?.({ runId: "run-1", requestId: "offer", name: "offer_writing_help",
      args: { ...offer, thought_key: "opening" } }); });
    expect(agent.returnThought).not.toHaveBeenCalled();
    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } }));
    await settle();
    expect(current.writingOffer?.prepared.offer.replacement).toBe("A quieter trip");
    expect(agent.returnThought).toHaveBeenCalledWith("/notes", "my-trip", READY.account!.email, 6, "opening", "A quieter trip");
    expect(editor.getText()).toBe("Trip plan");
  });
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
  async function backgroundOffer(args: typeof offer) {
    await readyWithModels();
    vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: "clarity", anchor: 0, route: "fast" });
    await act(async () => { await current.startCompanion(); });
    await deliver(args);
  }
  it("makes a short unrequested rewrite itself, away from the writer's cursor, and takes it back on Undo", async () => {
    act(() => { editor.commands.setContent("<p>Trip plan</p><p>Pack light.</p>"); editor.commands.setTextSelection(14); });
    await backgroundOffer(offer);
    expect(editor.getText()).toBe("A quieter trip\n\nPack light.");
    expect(current.writingOffer).toBeNull();
    expect(current.writingSuggestion).toMatchObject({ applied: true, text: "Give the opening a clearer direction." });
    // The writer's cursor stays where they left it.
    expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.doc.content.size)).toBe("ck light.");
    act(() => current.undoAppliedSuggestion());
    expect(editor.getText()).toBe("Trip plan\n\nPack light.");
    expect(current.writingSuggestion).toBeNull();
    // An undone change is remembered, so the agent does not make it again.
    vi.useFakeTimers();
    act(() => editor.commands.insertContent("x"));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(agent.reviewWriting).toHaveBeenLastCalledWith(expect.objectContaining({ dismissed: ["Give the opening a clearer direction."] }));
  });
  it("only offers a rewrite from a check that could read the web", async () => {
    act(() => { editor.commands.setContent("<p>Trip plan</p><p>Pack light.</p>"); editor.commands.setTextSelection(14); });
    await readyWithModels();
    act(() => current.setWebAccess(true));
    // An evidence check is the one background run allowed to research.
    vi.mocked(agent.reviewWriting).mockResolvedValue({ focus: "evidence", anchor: 0, route: "fast" });
    await act(async () => { await current.startCompanion(); });
    expect(agent.startRun).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true, webAccess: true }));
    await deliver(offer);
    expect(editor.getText()).toBe("Trip plan\n\nPack light.");
    expect(current.writingOffer?.prepared.offer).toEqual(offer);
  });
  it("only offers a rewrite of the sentence the writer is in", async () => {
    act(() => editor.commands.setTextSelection(3));
    await backgroundOffer(offer);
    expect(editor.getText()).toBe("Trip plan");
    expect(current.writingOffer?.prepared.offer).toEqual(offer);
    expect(current.writingSuggestion?.applied).toBeUndefined();
  });
  it("only offers a rewrite too long to land unread", async () => {
    const long = { ...offer, replacement: "A quieter trip ".repeat(30).trim() };
    act(() => { editor.commands.setContent("<p>Trip plan</p><p>Pack light.</p>"); editor.commands.setTextSelection(14); });
    await backgroundOffer(long);
    expect(editor.getText()).toBe("Trip plan\n\nPack light.");
    expect(current.writingOffer?.prepared.offer).toEqual(long);
  });
  it("lets a newer check replace an unread offer, but not one the writer has started rewording", async () => {
    act(() => editor.commands.setTextSelection(3));
    await backgroundOffer(offer);
    vi.useFakeTimers();
    const pause = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); };
    const reviews = () => vi.mocked(agent.reviewWriting).mock.calls.length;
    const before = reviews();
    act(() => { editor.commands.setTextSelection(editor.state.doc.content.size - 1); editor.commands.insertContent(" More."); });
    await pause();
    expect(reviews()).toBe(before + 1);
    act(() => current.setWritingOfferDraft("My own wording"));
    act(() => editor.commands.insertContent(" Again."));
    await pause();
    expect(reviews()).toBe(before + 1);
  });
  it("uses the selected model for heavy work and the same model for delegated research", async () => {
    await readyWithModels();
    act(() => { current.setModel("gpt-x"); current.setWebAccess(true); });
    vi.mocked(agent.classifyInlineContext).mockResolvedValueOnce({ intent: "research", confidence: 0.98, route: "deep" });
    await act(async () => { await current.requestWritingHelp("evidence"); });
    expect(agent.startRun).toHaveBeenLastCalledWith(expect.objectContaining({ model: "gpt-x", researchModel: "gpt-x", webAccess: true, readOnly: true }));
  });
  it("anchors other help on a highlight in that passage", async () => {
    await readyWithModels();
    const from = 1 + editor.getText().indexOf("Trip plan");
    await act(async () => { await current.requestWritingHelp("rewrite", { focus: { from, to: from + "Trip plan".length } }); });
    // Help the writer asked for, which the panel shows working; a background check stays in the header.
    expect(current.companionRequested).toBe(true);
    const prompt = vi.mocked(agent.startRun).mock.lastCall![0].prompt;
    expect(prompt).toContain("Work on the passage I highlighted");
    expect(prompt).toContain('"highlighted":"Trip plan"');
  });
  it("traces the argument in a highlighted passage and opens the map of the answer", async () => {
    await readyWithModels();
    Element.prototype.scrollIntoView = vi.fn();
    const text = editor.getText();
    const from = 1 + text.indexOf("Trip plan");
    await act(async () => { await current.requestWritingHelp("outcome", { focus: { from, to: from + "Trip plan".length } }); });
    const prompt = vi.mocked(agent.startRun).mock.lastCall![0].prompt;
    expect(prompt).toContain("Work back from the passage I highlighted");
    expect(prompt).toContain('"highlighted":"Trip plan"');
    const traced = { ...offer, kind: "question", replacement: null, question: "Where does the trip go?",
      trace: [{ quote: "Trip plan", reading: "You open with a plan.", sure: false }] };
    vi.useFakeTimers();
    await deliver(traced);
    // It opens playing from the first step, one step at a time, and stops at the outcome.
    expect(current.argumentMap).toEqual({ id: "run-1", active: 0, playing: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(1400); });
    expect(current.argumentMap).toEqual({ id: "run-1", active: 1, playing: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(current.argumentMap?.active).toBe(1);
    vi.useRealTimers();
    // Picking a step takes over; closing and opening plays it again.
    act(() => current.focusArgumentStep(0));
    expect(current.argumentMap).toEqual({ id: "run-1", active: 0, playing: false });
    act(() => current.toggleArgumentMap());
    expect(current.argumentMap).toBeNull();
    act(() => current.toggleArgumentMap());
    expect(current.argumentMap).toEqual({ id: "run-1", active: 0, playing: true });
  });
  it("works back from a highlight through the conversation, accepting only steps the ledger holds", async () => {
    await readyWithModels();
    await act(async () => { await current.send("Make the trip plan quieter"); });
    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } }));
    await settle();
    const from = 1 + editor.getText().indexOf("Trip plan");
    await act(async () => { await current.requestWritingHelp("outcome", { focus: { from, to: from + "Trip plan".length } }); });
    const prompt = vi.mocked(agent.startRun).mock.lastCall![0].prompt;
    expect(prompt).toContain('"ledger":[{"kind":"you","label":"You said","text":"Make the trip plan quieter","id":"e1"}]');
    const runId = "run-1";
    const traced = { ...offer, kind: "question", replacement: null, question: "Is quieter still the aim?",
      trace: [{ quote: "trip plan quieter", reading: "You asked for a quieter trip.", sure: true, source: "e1" }] };
    await act(async () => { await mocks.toolHandler?.({ runId, requestId: "offer-2", name: "offer_writing_help", args: traced }); });
    expect(agent.toolRespond).toHaveBeenLastCalledWith("offer-2", true, expect.any(String));
    act(() => mocks.eventHandler?.({ runId, event: { type: "done", stopReason: "completed" } }));
    await settle();
    expect(current.writingOffer?.prepared.provenance[0]?.kind).toBe("you");
    expect(current.argumentMap).toEqual({ id: runId, active: 0, playing: true });
    // The map joins the conversation, which gets a saved session to keep it in, and what it learned joins memory.
    const record = current.conversation.items.find(item => item.type === "trace");
    expect(record).toMatchObject({ id: `trace:${runId}`, requested: "outcome", outcome: { text: "Trip plan", paragraphs: 1 }, corrections: [] });
    await settle();
    expect(agent.beginConversation).toHaveBeenCalledWith("trip", "Traced: Trip plan");
    expect(agent.saveConversation).toHaveBeenLastCalledWith("session-traced", expect.arrayContaining([expect.objectContaining({ type: "trace" })]));
    expect(agent.recordTraceMemory).toHaveBeenCalledWith("/notes", "test-document", expect.any(String),
      { kind: "insight", quote: "Trip plan", outcome: "Trip plan", learned: offer.explanation });

    // Correcting a step keeps the writer's words on the map and as what they meant.
    vi.mocked(agent.recordTraceMemory).mockClear();
    await act(async () => { await current.requestWritingHelp("realign", { answer: "I meant a slow trip.", step: 0 }); });
    expect(current.conversation.items.find(item => item.type === "trace")).toMatchObject({
      corrections: [{ step: 0, quote: "trip plan quieter", readAs: "You asked for a quieter trip.", meant: "I meant a slow trip." }] });
    expect(agent.recordTraceMemory).toHaveBeenCalledWith("/notes", "test-document", expect.any(String),
      { kind: "meaning", quote: "trip plan quieter", meant: "I meant a slow trip.", read_as: "You asked for a quieter trip." });
    act(() => mocks.eventHandler?.({ runId, event: { type: "done", stopReason: "completed" } }));
    await settle();

    // The next message to the main agent carries the map once.
    await act(async () => { await current.send("Now tighten the opening"); });
    const sent = vi.mocked(agent.startRun).mock.lastCall![0].prompt;
    expect(sent).toContain("Since your last turn, the writer traced arguments");
    expect(sent).toContain("The writer corrected step 1");
    expect(sent).toContain("The writer's message:\nNow tighten the opening");
    expect(current.conversation.items.find(item => item.type === "trace")).toMatchObject({ delivered: true });
    expect([...current.conversation.items].reverse().find(item => item.type === "user")).toMatchObject({ text: "Now tighten the opening" });
  });
  it("takes Show passage to where the agent got lost, and tints it while the card is looked at", async () => {
    await readyWithModels();
    Element.prototype.scrollIntoView = vi.fn();
    editor.commands.setContent("<p>First premise.</p><p>Trip plan</p>");
    await act(async () => { await current.requestWritingHelp("question"); });
    await deliver({ ...offer, kind: "question", replacement: null, question: "Why?",
      trace: [{ quote: "First premise.", reading: "You start here.", sure: true, source: null }] });
    const { offerPassageState } = await import("../components/editor/ArgumentMap");
    act(() => current.highlightWritingOffer(true));
    const source = current.writingOffer!.prepared.source;
    expect(offerPassageState(editor)).toEqual({ ...source, flash: 0 });
    act(() => current.showWritingOffer());
    expect(offerPassageState(editor)).toMatchObject({ ...source, flash: expect.any(Number) });
    expect(offerPassageState(editor)!.flash).toBeGreaterThan(0);
    // The card's passage, not the first step of the trace.
    expect(editor.state.doc.textBetween(source.from, source.to)).toBe("Trip plan");
    act(() => current.highlightWritingOffer(false));
    expect(offerPassageState(editor)).toBeNull();
  });
  it("sends a correction to a misread step with the earlier reasoning", async () => {
    await readyWithModels();
    await act(async () => { await current.requestWritingHelp("rewrite"); });
    await deliver({ ...offer, trace: [{ quote: "Trip plan", reading: "You want a busy trip.", sure: true }] });
    expect(current.argumentMap).toBeNull();
    await act(async () => { await current.requestWritingHelp("realign", { answer: "I want a slow one.", step: 0 }); });
    const prompt = vi.mocked(agent.startRun).mock.lastCall![0].prompt;
    expect(prompt).toContain('you read "Trip plan" as: You want a busy trip.');
    expect(prompt).toContain("I meant: I want a slow one.");
    expect(prompt).toContain('"correctedStep":1');
  });
  it("supplies the conversation ledger to question and realign traces, re-delivers late corrections, and reloads saved maps", async () => {
    await readyWithModels();
    await act(async () => { await current.send("Keep the coastal route."); });
    act(() => {
      mocks.eventHandler?.({ runId: "run-1", event: { type: "text_delta", text: "We can anchor the route at Big Sur." } });
      mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } });
    });
    await settle();

    // Forward "Trace my argument" now receives the conversation ledger.
    await act(async () => { await current.requestWritingHelp("question"); });
    const questionPrompt = vi.mocked(agent.startRun).mock.lastCall![0].prompt;
    expect(questionPrompt).toContain('"text":"Keep the coastal route."');
    expect(questionPrompt).toContain('"text":"We can anchor the route at Big Sur."');
    await deliver({
      ...offer,
      kind: "question",
      replacement: null,
      question: "Why Big Sur?",
      trace: [{ quote: "anchor the route at Big Sur", reading: "We discussed Big Sur.", sure: true, source: "e2" }],
    });
    expect(current.writingOffer?.prepared.provenance[0]?.kind).toBe("chat");

    const savedTrace = current.conversation.items.find(item => item.type === "trace")!;
    expect(savedTrace).toBeDefined();

    // A coedit check-in delivers the map to the main agent without closing the open offer;
    // correcting a step afterward clears `delivered` so the writer's next message carries it.
    await act(async () => { await current.send("Document activity", false, "coedit", { checkIn: true }); });
    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } }));
    await settle();
    expect(current.conversation.items.find(item => item.type === "trace")).toMatchObject({ delivered: true });

    await act(async () => { await current.requestWritingHelp("realign", { answer: "Big Sur is a day stop, not the hub.", step: 0 }); });
    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } }));
    await settle();
    expect(current.conversation.items.find(item => item.type === "trace")?.delivered).toBeUndefined();

    await act(async () => { await current.send("Update the itinerary"); });
    expect(vi.mocked(agent.startRun).mock.lastCall![0].prompt).toContain("Big Sur is a day stop, not the hub.");
    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } }));
    await settle();

    // Reloading a saved conversation preserves valid trace records and drops corrupt ones.
    vi.mocked(agent.loadConversation).mockResolvedValueOnce([
      { id: "u-saved", type: "user", text: "Keep the coastal route." },
      { ...savedTrace, delivered: true },
      { id: "trace:corrupt", type: "trace", offer: { quote: 123 } },
    ]);
    await act(async () => { await current.openConversation("session-saved"); });
    const reloaded = current.conversation.items.filter(item => item.type === "trace");
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({ id: savedTrace.id, delivered: true });
  });
  it("reanchors saved meaning quotes in working memory as the writer edits the passage", async () => {
    vi.mocked(agent.getNoteMemory).mockResolvedValue({
      documentId: "test-document",
      revision: 1,
      entries: [{ key: "meaning-trip", kind: "choice", status: "open", summary: "The writer means: A slow trip", quote: "Trip plan", next: null }],
    });
    await readyWithModels();
    await settle();

    // Editing inside the anchored quote updates its saved quote after idle.
    vi.useFakeTimers();
    act(() => {
      const pos = 1 + editor.getText().indexOf("plan");
      editor.view.dispatch(editor.state.tr.insertText("coastal ", pos));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    await settle();
    expect(agent.recordTraceMemory).toHaveBeenCalledWith("/notes", "test-document", "me@example.com", {
      kind: "reanchor",
      key: "meaning-trip",
      quote: "Trip coastal plan",
    });
    vi.useRealTimers();
  });
  it("opens chat-authored argument maps, passes open maps to chat, and confirms unsure steps in one click", async () => {
    await readyWithModels();
    editor.commands.setContent("<p>Premise one.</p><p>Trip plan</p>");

    // A main chat turn that maps the argument opens the margin map and saves the trace record.
    await act(async () => { await current.send("Map how my argument connects"); });
    await act(async () => {
      await mocks.toolHandler?.({
        runId: "run-1",
        requestId: "chat-map-1",
        name: "offer_writing_help",
        args: {
          ...offer,
          kind: "question",
          replacement: null,
          question: "How does Premise one lead to Trip plan?",
          trace: [{ quote: "Premise one.", reading: "Assumed premise.", sure: false, source: null, leads_to: null, role: "supports" }],
        },
      });
    });
    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } }));
    await settle();
    expect(current.argumentMap).toEqual({ id: "run-1", active: 0, playing: true });
    expect(current.writingOffer?.prepared.offer.trace[0].sure).toBe(false);
    expect(current.conversation.items.find(item => item.type === "trace")).toMatchObject({ requested: "chat", delivered: true });

    // Confirming an unsure assumption turns it solid immediately and saves it to working memory.
    vi.mocked(agent.recordTraceMemory).mockClear();
    act(() => current.confirmArgumentStep(0));
    expect(current.writingOffer?.prepared.offer.trace[0].sure).toBe(true);
    expect(agent.recordTraceMemory).toHaveBeenCalledWith("/notes", "test-document", "me@example.com", {
      kind: "meaning",
      quote: "Premise one.",
      meant: "Assumed premise.",
      read_as: "",
    });
    expect(current.conversation.items.find(item => item.type === "trace")).toMatchObject({
      confirmed: [{ step: 0, quote: "Premise one.", reading: "Assumed premise." }],
    });
  });
  it("suppresses a background check-in gap already answered in conversation and supports 1-click source checks on unsure steps", async () => {
    editor.commands.setContent("<p>Latency dropped 40%.</p><p>Pack light.</p>");
    editor.commands.setTextSelection(30);
    await readyWithModels();

    // Earlier conversation turn answers the latency question.
    await act(async () => { await current.send("The 40% drop refers to p99 tail latency."); });
    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } }));
    await settle();

    // A background check-in later tries to surface that same uncertainty as a question gap: it is suppressed, keeping starters.
    vi.mocked(agent.reviewWriting).mockResolvedValueOnce({ focus: "clarity", anchor: 0, route: "fast" });
    await act(async () => { await current.startCompanion(); });
    const checkInPrompt = vi.mocked(agent.startRun).mock.lastCall![0].prompt;
    expect(checkInPrompt).toContain("p99 tail latency");
    await act(async () => {
      await mocks.toolHandler?.({
        runId: "run-1",
        requestId: "offer-dup",
        name: "offer_writing_help",
        args: {
          ...offer,
          kind: "question",
          quote: "Latency dropped 40%.",
          replacement: null,
          question: "Is this p99 latency?",
          trace: [{ quote: "Latency dropped 40%.", reading: "I took this as p99 latency.", sure: false }],
        },
      });
    });
    act(() => {
      mocks.eventHandler?.({
        runId: "run-1",
        event: { type: "text_delta", text: "Starters:\nCompare median latency\nAdd benchmark setup" },
      });
      mocks.eventHandler?.({ runId: "run-1", event: { type: "done", stopReason: "completed" } });
    });
    await settle();
    expect(current.writingOffer).toBeNull();
    expect(current.writingStarters).toEqual(["Compare median latency", "Add benchmark setup"]);

    // For a genuine new unsure step, 1-click "Check a source" runs web evidence targeted at that step's assumption.
    act(() => current.setWebAccess(true));
    await act(async () => { await current.requestWritingHelp("rewrite"); });
    await deliver({
      ...offer,
      quote: "Latency dropped 40%.",
      replacement: "Tail latency fell by 40%.",
      trace: [{ quote: "Pack light.", reading: "Assumed mobile cold-start budget under 200ms.", sure: false }],
    });
    expect(current.writingOffer?.prepared.offer.trace[0].sure).toBe(false);
    await act(async () => { await current.requestWritingHelp("evidence", { step: 0 }); });
    const evidenceCall = vi.mocked(agent.startRun).mock.lastCall![0];
    expect(evidenceCall.webAccess).toBe(true);
    expect(evidenceCall.prompt).toContain('Check a source for step 1 of how you read this note ("Pack light.")');
    expect(evidenceCall.prompt).toContain("Assumed mobile cold-start budget under 200ms.");
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
  it("keeps the map through an edit to a traced passage, pauses and resumes it, and puts a kept map back on the note", async () => {
    editor.commands.setContent("<p>Pack light.</p><p>Trip plan</p>");
    Element.prototype.scrollIntoView = vi.fn();
    await readyWithModels();
    await act(async () => { await current.requestWritingHelp("question"); });
    await deliver({ ...offer, kind: "question", replacement: null, question: "Where does the trip go?",
      trace: [{ quote: "Pack light.", reading: "You start with the bags.", sure: true }] });
    expect(current.argumentMap).toEqual({ id: "run-1", active: 0, playing: true });

    // Pausing holds the step being read; playing again carries on from it, or from the top once it has finished.
    act(() => current.playArgumentMap());
    expect(current.argumentMap).toEqual({ id: "run-1", active: 0, playing: false });
    act(() => current.focusArgumentStep(1));
    act(() => current.playArgumentMap());
    expect(current.argumentMap).toEqual({ id: "run-1", active: 0, playing: true });

    // The map is an invitation to fix what it points at. Fixing a step's passage must not take the map away.
    act(() => { editor.commands.insertContentAt(6, "very "); });
    expect(editor.getText()).toContain("Pack very light.");
    expect(current.writingOffer).toMatchObject({ stale: false, prepared: { edited: [true] } });
    const kept = current.writingOffer!.prepared.trace[0]!;
    expect(editor.state.doc.textBetween(kept.from, kept.to)).toBe("Pack very light.");
    expect(current.argumentMap?.id).toBe("run-1");

    // A map kept in the conversation goes back on the note after its card is gone, finding its passages by their
    // text: the step that no longer reads as quoted is kept, without a place.
    const record = current.conversation.items.find(item => item.type === "trace") as TraceRecord;
    act(() => current.dismissWritingSuggestion());
    expect(current.writingOffer).toBeNull();
    act(() => current.reopenTrace(record));
    expect(current.writingOffer).toMatchObject({ id: "run-1", stale: false, prepared: { trace: [null], edited: [true] } });
    expect(current.argumentMap).toEqual({ id: "run-1", active: 0, playing: true });

    // Without the passage the map led to there is nothing to anchor it to, and the writer is told why.
    const failed = vi.spyOn(toast, "error").mockImplementation(() => "");
    act(() => current.dismissWritingSuggestion());
    act(() => { editor.commands.setContent("<p>A different thought</p>"); });
    act(() => current.reopenTrace(record));
    expect(current.writingOffer).toBeNull();
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("can't be shown on the note"));
    failed.mockRestore();
  });
  it("stops playback when the note is typed in, reads the open card's steps, and keeps a card being answered", async () => {
    editor.commands.setContent("<p>Pack light.</p><p>Bring a map.</p><p>Trip plan</p>");
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await readyWithModels();
    await act(async () => { await current.requestWritingHelp("question"); });
    await deliver({ ...offer, kind: "question", replacement: null, question: "Where does the trip go?", trace: [
      { quote: "Pack light.", reading: "You start with the bags.", sure: false },
      { quote: "Bring a map.", reading: "You expect to get lost.", sure: true }] });
    expect(current.argumentMap).toEqual({ id: "run-1", active: 0, playing: true });

    // Playback scrolls each step into view. Left running while the writer types, it would pull the page off their caret.
    act(() => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, "s"); });
    expect(current.writingOffer?.stale).toBe(false);
    expect(current.argumentMap).toEqual({ id: "run-1", active: 0, playing: false });

    // A map kept in the conversation lists the same step numbers; the panel follows the open card's row.
    const panel = document.body.appendChild(document.createElement("div"));
    panel.className = "agent-panel";
    panel.innerHTML = '<div id="kept" data-trace-step="1"></div><div id="live" data-trace-live="true" data-trace-step="1"></div>';
    act(() => current.focusArgumentStep(1));
    const rows = scrolled.mock.contexts.map(element => (element as Element).id).filter(Boolean);
    expect(rows).toEqual(["live"]);
    panel.remove();

    // An assumption about a sentence the writer has since reworded can't be confirmed as it stood.
    act(() => { editor.commands.insertContentAt(6, "very "); });
    expect(current.writingOffer?.prepared.edited).toEqual([true, false]);
    act(() => current.confirmArgumentStep(0));
    expect(current.writingOffer?.prepared.offer.trace[0].sure).toBe(false);
    expect(current.writingOffer?.prepared.confirmedSteps).toBeUndefined();

    // Half an answer is written. Its own map reopens over it; another map is refused, so the answer isn't lost.
    const record = current.conversation.items.find(item => item.type === "trace") as TraceRecord;
    const refused = vi.spyOn(toast, "error").mockImplementation(() => "");
    act(() => current.setWritingOfferDraft("Somewhere quiet"));
    act(() => current.toggleArgumentMap());
    expect(current.argumentMap).toBeNull();
    act(() => current.reopenTrace(record));
    expect(current.argumentMap).toEqual({ id: "run-1", active: 0, playing: true });
    expect(current.writingOfferDraft).toBe("Somewhere quiet");
    act(() => current.reopenTrace({ ...record, id: "trace:other", offerId: "other" }));
    expect(current.writingOffer?.id).toBe("run-1");
    expect(current.writingOfferDraft).toBe("Somewhere quiet");
    expect(refused).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("isn't lost"));

    // A question the writer already answered comes back saying so, and keeps saying so as the note changes.
    act(() => current.dismissWritingSuggestion());
    act(() => current.reopenTrace({ ...record, answer: "The coast." }));
    expect(current.writingOffer?.prepared.answered).toBe("The coast.");
    act(() => { editor.commands.insertContentAt(1, "Always "); });
    expect(current.writingOffer).toMatchObject({ stale: false, prepared: { answered: "The coast." } });

    // The writer is told what is actually in the way: here the passage is in the note twice.
    act(() => current.dismissWritingSuggestion());
    act(() => { editor.commands.setContent("<p>Trip plan</p><p>Trip plan</p>"); });
    act(() => current.reopenTrace(record));
    expect(current.writingOffer).toBeNull();
    expect(refused).toHaveBeenLastCalledWith(expect.stringContaining("more than once"));
    refused.mockRestore();
  });
  it("puts a map traced back from a highlight on the note with its highlight, found again by its text", async () => {
    await readyWithModels();
    Element.prototype.scrollIntoView = vi.fn();
    const from = 1 + editor.getText().indexOf("Trip plan");
    await act(async () => { await current.requestWritingHelp("outcome", { focus: { from, to: from + "Trip plan".length } }); });
    await deliver({ ...offer, kind: "question", replacement: null, question: "Where does the trip go?",
      trace: [{ quote: "Trip plan", reading: "You open with a plan.", sure: true }] });
    const record = current.conversation.items.find(item => item.type === "trace") as TraceRecord;
    expect(record.outcome?.text).toBe("Trip plan");
    act(() => current.dismissWritingSuggestion());
    // Positions saved with the map would be wrong by now; the highlight's words are still there.
    act(() => { editor.commands.insertContentAt(0, "<p>A new opening.</p>"); });
    act(() => current.reopenTrace(record));
    const outcome = current.writingOffer!.prepared.outcome!;
    expect(editor.state.doc.textBetween(outcome.from, outcome.to)).toBe("Trip plan");
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

describe("AgentProvider steer", () => {
  const texts = () => current.conversation.items.map((item) => ("text" in item ? item.text : item.type));

  it("hands the working agent a message, shows it, and lets the reply continue after it", async () => {
    act(() => current.toggle());
    await settle();
    await act(async () => { await current.send("Plan the trip"); });
    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "text_delta", text: "Drafting" } }));

    await act(async () => { expect(await current.steer("  Keep it to two days  ")).toBe(true); });
    expect(agent.steerRun).toHaveBeenCalledWith("run-1", "Keep it to two days");
    expect(agent.startRun).toHaveBeenCalledOnce();
    expect(current.conversation.runId).toBe("run-1");

    act(() => mocks.eventHandler?.({ runId: "run-1", event: { type: "text_delta", text: "Two days it is." } }));
    expect(texts().slice(-3)).toEqual(["Drafting", "Keep it to two days", "Two days it is."]);
  });

  it("steers nothing when no request is running, and keeps the message when Codex refuses", async () => {
    act(() => current.toggle());
    await settle();
    await act(async () => { expect(await current.steer("Keep it short")).toBe(false); });
    expect(agent.steerRun).not.toHaveBeenCalled();

    await act(async () => { await current.send("Plan the trip"); });
    const before = current.conversation.items.length;
    vi.mocked(agent.steerRun).mockRejectedValueOnce("The agent has already finished. Send this as a new message.");
    await act(async () => { expect(await current.steer("Keep it short")).toBe(false); });
    expect(current.conversation.items).toHaveLength(before);
    await act(async () => { expect(await current.steer("   ")).toBe(false); });
    expect(agent.steerRun).toHaveBeenCalledOnce();
  });
});
