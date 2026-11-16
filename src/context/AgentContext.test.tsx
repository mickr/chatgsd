// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "../services/agent";
import type { Note } from "../types/note";
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
  applyNoteEdit: vi.fn(),
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
// Document tools are mocked, so the provider only needs a non-null editor.
const fakeEditor = {} as unknown as Editor;

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
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      <AgentProvider editorRef={{ current: fakeEditor }} editor={null}>
        <Probe />
      </AgentProvider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
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

describe("AgentProvider edit_note", () => {
  const proposal = {
    id: "Packing tips",
    title: "Packing tips",
    summary: "Add the power bank from the trip plan.",
    edits: [{ old_text: "- Rain jacket", new_text: "- Rain jacket\n- Power bank" }],
    preview: [
      { before: "", removed: "- Rain jacket", added: "- Rain jacket\n- Power bank", after: "" },
    ],
  };

  async function propose() {
    act(() => current.toggle());
    await settle();
    await act(async () => {
      await current.send("Sync my packing list");
    });
    act(() =>
      mocks.toolHandler?.({
        requestId: "e1",
        runId: "run-1",
        name: "edit_note",
        args: proposal,
      }),
    );
    await settle();
  }
  const card = () =>
    current.conversation.items.find((item) => item.type === "note_edit");

  it("writes an approved edit and tells the run", async () => {
    vi.mocked(agent.applyNoteEdit).mockResolvedValue();
    await propose();
    expect(current.pendingEdit).toMatchObject({ noteId: "Packing tips", status: "pending" });

    await act(async () => {
      await current.reviewNoteEdit({ approve: true });
    });
    expect(agent.applyNoteEdit).toHaveBeenCalledWith("Packing tips", proposal.edits);
    expect(agent.toolRespond).toHaveBeenCalledWith(
      "e1",
      true,
      'The user approved, and the edit to "Packing tips" is saved.',
    );
    expect(card()).toMatchObject({ status: "applied" });
    expect(current.pendingEdit).toBeNull();
  });

  it("reports a failed save instead of claiming success", async () => {
    vi.mocked(agent.applyNoteEdit).mockRejectedValue(
      new Error("The note changed since this was proposed."),
    );
    await propose();
    await act(async () => {
      await current.reviewNoteEdit({ approve: true });
    });
    expect(agent.toolRespond).toHaveBeenCalledWith(
      "e1",
      false,
      "The user approved, but the edit couldn't be saved: The note changed since this was proposed.",
    );
    expect(card()).toMatchObject({
      status: "failed",
      message: "The note changed since this was proposed.",
    });
  });

  it("declines with the user's feedback and writes nothing", async () => {
    await propose();
    await act(async () => {
      await current.reviewNoteEdit({ approve: false, feedback: "  Put it under Electronics  " });
    });
    expect(agent.applyNoteEdit).not.toHaveBeenCalled();
    expect(agent.toolRespond).toHaveBeenCalledWith(
      "e1",
      false,
      "The user declined this edit and said: Put it under Electronics",
    );
    expect(card()).toMatchObject({ status: "declined", message: "Put it under Electronics" });
  });
});
