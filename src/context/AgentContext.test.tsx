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

describe("AgentProvider conversation history", () => {
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
    expect(agent.saveConversation).toHaveBeenCalledWith("trip", "saved-turn",
      expect.arrayContaining([{ id: "edit-request:changes", type: "changes", change }]));
    act(() => mocks.eventHandler?.({
      runId: "run-1", event: { type: "error", kind: "other", message: "Connection lost" },
    }));
    await settle();
    const calls = vi.mocked(agent.saveConversation).mock.calls;
    const saved = calls[calls.length - 1][2];
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
    const [noteId, sessionId, items] = vi.mocked(agent.saveConversation).mock
      .calls[0];
    expect([noteId, sessionId]).toEqual(["trip", "s-old"]);
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
