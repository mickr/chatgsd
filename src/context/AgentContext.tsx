import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { Editor } from "@tiptap/react";
import { toast } from "sonner";
import { useNotes } from "./NotesContext";
import * as agent from "../services/agent";
import * as notes from "../services/notes";
import type { Settings } from "../types/note";
import type { Spec } from "@json-render/core";
import { uiGuide } from "../lib/agent/ui/catalog";
import { renderableSpec } from "../lib/agent/ui/content";
import { clipPreview } from "../lib/agent/selection";
import {
  captureRunBinding,
  releaseRunBinding,
  executeDocumentTool,
  type RunBinding,
} from "../lib/agent/documentTools";

export type TranscriptItem =
  | { id: string; type: "text"; text: string }
  | {
      id: string;
      type: "user";
      text: string;
      /** The opening of the selection the message was sent with. */
      selection?: string;
    }
  | {
      id: string;
      type: "tool";
      name: string;
      input: unknown;
      ok?: boolean;
      output?: string;
    }
  | {
      id: string;
      type: "question";
      runId: string;
      requestId: string;
      question: string;
      options: string[];
      form: Spec | null;
      answer: string | null;
    }
  | {
      id: string;
      type: "note_edit";
      runId: string;
      requestId: string;
      noteId: string;
      title: string;
      summary: string;
      edits: NoteEdit[];
      preview: NoteEditPreview[];
      status: "pending" | "applying" | "applied" | "declined" | "failed";
      /** The decline feedback or the save error. */
      message: string | null;
    };
export type QuestionItem = Extract<TranscriptItem, { type: "question" }>;
export type NoteEditItem = Extract<TranscriptItem, { type: "note_edit" }>;
export interface NoteEdit {
  old_text: string;
  new_text: string;
}
/** One edit as reviewed: the replaced text with the rest of its line. */
export interface NoteEditPreview {
  before: string;
  removed: string;
  added: string;
  after: string;
}
export type NoteEditDecision =
  | { approve: true }
  | { approve: false; feedback?: string };
/** A form submission (the bound answers object) or a typed/picked answer. */
export type QuestionAnswer = string | Record<string, unknown>;

const MAX_QUESTION_OPTIONS = 6;

function parseQuestion(args: unknown) {
  const input =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const question =
    typeof input.question === "string" ? input.question.trim() : "";
  const options = Array.isArray(input.options)
    ? input.options
        .filter(
          (option): option is string =>
            typeof option === "string" && option.trim() !== "",
        )
        .slice(0, MAX_QUESTION_OPTIONS)
    : [];
  return { question, options, form: renderableSpec(input.form) };
}

const isString = (value: unknown): value is string => typeof value === "string";
const hasStrings = (value: unknown, keys: string[]) =>
  !!value &&
  typeof value === "object" &&
  keys.every((key) => isString((value as Record<string, unknown>)[key]));

/** An edit_note request from the backend, or null if it's malformed. */
function parseNoteEdit(args: unknown) {
  const input =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const { id, title, summary, edits, preview } = input;
  if (
    !isString(id) ||
    !isString(title) ||
    !isString(summary) ||
    !Array.isArray(edits) ||
    !Array.isArray(preview) ||
    !edits.every((edit) => hasStrings(edit, ["old_text", "new_text"])) ||
    !preview.every((hunk) =>
      hasStrings(hunk, ["before", "removed", "added", "after"]),
    )
  )
    return null;
  return {
    noteId: id,
    title,
    summary,
    edits: edits as NoteEdit[],
    preview: preview as NoteEditPreview[],
  };
}

/** Tools that show as their own card instead of a tool row. */
const CARD_TOOLS = new Set(["ask_user", "edit_note"]);

function describeAnswer(answer: QuestionAnswer) {
  if (typeof answer === "string")
    return { display: answer, output: `The user answered: ${answer}` };
  const display = Object.values(answer)
    .map((value) => (Array.isArray(value) ? value.join(", ") : String(value)))
    .filter((value) => value && value !== "null")
    .join(" · ");
  return {
    display: display || "Sent",
    output: `The user submitted the form. Answers: ${JSON.stringify(answer)}`,
  };
}
export interface Conversation {
  items: TranscriptItem[];
  sessionId: string | null;
  runId: string | null;
  context: agent.RunContext | null;
  error: { kind: agent.AgentErrorKind; message: string } | null;
  cancelled: boolean;
}
const emptyConversation = (): Conversation => ({
  items: [],
  sessionId: null,
  runId: null,
  context: null,
  error: null,
  cancelled: false,
});
const TRANSCRIPT_TYPES = new Set(["user", "text", "tool", "question", "note_edit"]);
/** A saved transcript, keeping only items this version knows how to show. */
function parseTranscript(value: unknown): TranscriptItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is TranscriptItem =>
      !!item &&
      typeof item === "object" &&
      typeof item.id === "string" &&
      TRANSCRIPT_TYPES.has(item.type),
  );
}
interface ActiveRun {
  binding: RunBinding;
  noteId: string;
  cancelRequested: boolean;
}
export interface AgentContextValue {
  open: boolean;
  toggle: () => void;
  close: () => void;
  focusComposer: number;
  width: number;
  setWidth: (width: number, persist?: boolean) => void;
  model: string;
  setModel: (model: string) => void;
  models: agent.ModelInfo[];
  modelsLoading: boolean;
  modelsError: string | null;
  reloadModels: () => void;
  status: agent.AgentStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  refreshStatus: () => Promise<void>;
  /** The current note's unanswered ask_user question while its run is active. */
  pendingQuestion: QuestionItem | null;
  answerQuestion: (answer: QuestionAnswer) => Promise<void>;
  /** The current note's proposed edit to another note, while its run waits. */
  pendingEdit: NoteEditItem | null;
  reviewNoteEdit: (decision: NoteEditDecision) => Promise<void>;
  conversation: Conversation;
  send: (prompt: string) => Promise<boolean>;
  stop: () => Promise<void>;
  newConversation: () => void;
  /** The current note's saved conversations, most recent first. */
  history: agent.ConversationSummary[];
  openConversation: (sessionId: string) => Promise<void>;
  signingIn: boolean;
  signIn: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
  acknowledgePlan: () => Promise<void>;
  editor: Editor | null;
}
const AgentContext = createContext<AgentContextValue | null>(null);
export const PANEL_DEFAULT = 360;
export const PANEL_MIN = 300;
export const PANEL_MAX = 640;
export const clampPanelWidth = (width: number) =>
  Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, width)));

export function AgentProvider({
  editorRef,
  editor,
  children,
}: {
  editorRef: RefObject<Editor | null>;
  editor: Editor | null;
  children: ReactNode;
}) {
  const { currentNote, notesFolder } = useNotes();
  const [open, setOpen] = useState(false);
  const [focusComposer, setFocusComposer] = useState(0);
  const [width, updateWidth] = useState(PANEL_DEFAULT);
  const [savedModel, setSavedModel] = useState<string | null>(null);
  const [models, setModels] = useState<agent.ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [status, setStatus] = useState<agent.AgentStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [conversations, setConversations] = useState<
    Record<string, Conversation>
  >({});
  const conversationsRef = useRef(conversations);
  const runs = useRef(new Map<string, ActiveRun>());
  const buffered = useRef<Array<agent.AgentEventPayload | agent.ToolRequest>>(
    [],
  );
  const listenersReady = useRef<Promise<unknown>>(Promise.resolve());
  const persistQueue = useRef(Promise.resolve());
  const folderRef = useRef(notesFolder);
  folderRef.current = notesFolder;
  const updateConversation = useCallback(
    (id: string, change: (conversation: Conversation) => Conversation) => {
      const next = {
        ...conversationsRef.current,
        [id]: change(conversationsRef.current[id] ?? emptyConversation()),
      };
      conversationsRef.current = next;
      setConversations(next);
    },
    [],
  );
  const [history, setHistory] = useState<agent.ConversationSummary[]>([]);
  // The note whose history is showing; late list responses for other notes are dropped.
  const historyNote = useRef<string | null>(null);
  const refreshHistory = useCallback(async (noteId: string) => {
    const list = await agent.listConversations(noteId);
    if (historyNote.current === noteId) setHistory(list);
    return list;
  }, []);
  const saveConversation = useCallback(
    (noteId: string) => {
      const conversation = conversationsRef.current[noteId];
      if (!conversation?.sessionId || !conversation.items.length) return;
      agent
        .saveConversation(noteId, conversation.sessionId, conversation.items)
        .then(() => refreshHistory(noteId))
        .catch((error) =>
          toast.error(
            `Couldn't save this conversation: ${agent.errorMessage(error)}`,
          ),
        );
    },
    [refreshHistory],
  );
  const persist = useCallback((patch: Partial<Settings>) => {
    const folder = folderRef.current;
    persistQueue.current = persistQueue.current
      .catch(() => {})
      .then(async () => {
        if (!folder || folderRef.current !== folder) return;
        const settings = await notes.getSettings();
        if (folderRef.current === folder)
          await notes.updateSettings({ ...settings, ...patch });
      })
      .catch((error) => {
        toast.error(
          `Couldn't save agent settings: ${agent.errorMessage(error)}`,
        );
      });
  }, []);
  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      setStatus(await agent.getStatus());
    } catch (error) {
      setStatusError(agent.errorMessage(error));
    } finally {
      setStatusLoading(false);
    }
  }, []);
  useEffect(() => {
    if (open) void refreshStatus();
  }, [open, refreshStatus]);
  useEffect(() => {
    let active = true;
    setSavedModel(null);
    updateWidth(PANEL_DEFAULT);
    conversationsRef.current = {};
    setHistory([]);
    setConversations({});
    for (const [runId, run] of runs.current) {
      releaseRunBinding(editorRef.current, run.binding);
      if (!runId.startsWith("pending:"))
        void agent.cancelRun(runId).catch(() => {});
    }
    runs.current.clear();
    buffered.current = [];
    notes
      .getSettings()
      .then((settings) => {
        if (!active) return;
        setSavedModel(settings.agentModel ?? null);
        updateWidth(
          clampPanelWidth(settings.agentPanelWidthPx ?? PANEL_DEFAULT),
        );
      })
      .catch((error) => {
        if (active)
          toast.error(
            `Couldn't load agent settings: ${agent.errorMessage(error)}`,
          );
      });
    return () => {
      active = false;
    };
  }, [notesFolder, editorRef]);
  const ready = status?.status === "ready";
  // Bumped to retry the model list: readiness alone doesn't change when only
  // the /models request failed, so a status refresh wouldn't refetch.
  const [modelsRequest, setModelsRequest] = useState(0);
  const reloadModels = useCallback(
    () => setModelsRequest((value) => value + 1),
    [],
  );
  useEffect(() => {
    let active = true;
    setModels([]);
    setModelsError(null);
    if (!ready) {
      setModelsLoading(false);
      return;
    }
    setModelsLoading(true);
    agent
      .listModels()
      .then((result) => {
        if (active) setModels(result);
      })
      .catch((error) => {
        if (active) setModelsError(agent.errorMessage(error));
      })
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [ready, modelsRequest]);
  // A saved model the account can no longer use falls back to the first listed.
  const model = models.some((item) => item.id === savedModel)
    ? (savedModel ?? "")
    : (models[0]?.id ?? "");
  useEffect(() => {
    if (!editor) return;
    let previous: { noteId: string | null; session: number } | null = null;
    const followRename = () => {
      const document = editor.storage.scratchDocument as
        { noteId: string | null; session: number } | undefined;
      if (!document) return;
      if (
        previous?.noteId &&
        document.noteId &&
        previous.noteId !== document.noteId &&
        previous.session === document.session
      ) {
        const oldId = previous.noteId;
        const newId = document.noteId;
        const existing = conversationsRef.current[oldId];
        if (existing) {
          const next = { ...conversationsRef.current, [newId]: existing };
          delete next[oldId];
          conversationsRef.current = next;
          setConversations(next);
        }
        for (const run of runs.current.values())
          if (run.noteId === oldId) run.noteId = newId;
      }
      previous = { noteId: document.noteId, session: document.session };
    };
    followRename();
    editor.on("transaction", followRename);
    return () => {
      editor.off("transaction", followRename);
    };
  }, [editor]);
  const processEvent = useCallback(
    (payload: agent.AgentEventPayload) => {
      const run = runs.current.get(payload.runId);
      if (!run) {
        if ([...runs.current.keys()].some((id) => id.startsWith("pending:")))
          buffered.current.push(payload);
        return;
      }
      const event = payload.event;
      updateConversation(run.noteId, (conversation) => {
        if (event.type === "session")
          return { ...conversation, sessionId: event.sessionId };
        if (event.type === "text_delta") {
          const items = [...conversation.items];
          const last = items[items.length - 1];
          if (last?.type === "text")
            items[items.length - 1] = { ...last, text: last.text + event.text };
          else
            items.push({
              id: crypto.randomUUID(),
              type: "text",
              text: event.text,
            });
          return { ...conversation, items };
        }
        // Questions and note edit proposals show as cards, not tool rows.
        if (event.type === "tool_call" && !CARD_TOOLS.has(event.name))
          return {
            ...conversation,
            items: [
              ...conversation.items,
              {
                id: `${payload.runId}:${event.callId}`,
                type: "tool",
                name: event.name,
                input: event.input,
              },
            ],
          };
        if (event.type === "tool_call") return conversation;
        if (event.type === "tool_result")
          return {
            ...conversation,
            items: conversation.items.map((item) =>
              item.id === `${payload.runId}:${event.callId}` &&
              item.type === "tool"
                ? { ...item, ok: event.ok, output: event.output }
                : item,
            ),
          };
        if (event.type === "error")
          return {
            ...conversation,
            runId: null,
            error: { kind: event.kind, message: event.message },
          };
        return {
          ...conversation,
          runId: null,
          cancelled: event.stopReason === "cancelled",
        };
      });
      if (event.type === "done" || event.type === "error") {
        releaseRunBinding(editorRef.current, run.binding);
        runs.current.delete(payload.runId);
        saveConversation(run.noteId);
        if (event.type === "error" && event.kind === "auth")
          void refreshStatus();
      }
    },
    [editorRef, refreshStatus, saveConversation, updateConversation],
  );
  const processTool = useCallback(
    async (request: agent.ToolRequest) => {
      const run = runs.current.get(request.runId);
      if (!run) {
        if ([...runs.current.keys()].some((id) => id.startsWith("pending:")))
          buffered.current.push(request);
        return;
      }
      if (request.name === "edit_note") {
        const proposal = parseNoteEdit(request.args);
        if (!proposal) {
          await agent
            .toolRespond(request.requestId, false, "The edit proposal was malformed")
            .catch(() => {});
          return;
        }
        updateConversation(run.noteId, (conversation) => ({
          ...conversation,
          items: [
            ...conversation.items,
            {
              id: request.requestId,
              type: "note_edit",
              runId: request.runId,
              requestId: request.requestId,
              ...proposal,
              status: "pending",
              message: null,
            },
          ],
        }));
        saveConversation(run.noteId);
        return;
      }
      if (request.name === "ask_user") {
        const { question, options, form } = parseQuestion(request.args);
        if (!question) {
          await agent
            .toolRespond(request.requestId, false, "question must be a nonempty string")
            .catch(() => {});
          return;
        }
        updateConversation(run.noteId, (conversation) => ({
          ...conversation,
          items: [
            ...conversation.items,
            {
              id: request.requestId,
              type: "question",
              runId: request.runId,
              requestId: request.requestId,
              question,
              options,
              form,
              answer: null,
            },
          ],
        }));
        // The run may wait here for a long time; keep the question if the app closes.
        saveConversation(run.noteId);
        return;
      }
      let result: { ok: boolean; output: string };
      try {
        result = run.cancelRequested
          ? {
              ok: false,
              output: "The user stopped this run. No edit was applied.",
            }
          : await executeDocumentTool(
              editorRef.current,
              run.binding,
              request.name,
              request.args,
            );
      } catch (error) {
        result = { ok: false, output: agent.errorMessage(error) };
      }
      try {
        await agent.toolRespond(request.requestId, result.ok, result.output);
      } catch (error) {
        toast.error(`Couldn't answer the agent: ${agent.errorMessage(error)}`);
      }
    },
    [editorRef, saveConversation, updateConversation],
  );
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const register = (promise: Promise<() => void>) =>
      promise.then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });
    listenersReady.current = Promise.all([
      register(agent.onAgentEvent(processEvent)),
      register(
        agent.onToolRequest((request) => {
          void processTool(request);
        }),
      ),
    ]);
    // Retain the rejection for send(), but avoid an unhandled rejection before a user sends.
    void listenersReady.current.catch(() => {});
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
      for (const [runId, run] of runs.current) {
        releaseRunBinding(editorRef.current, run.binding);
        if (!runId.startsWith("pending:"))
          void agent.cancelRun(runId).catch(() => {});
      }
      runs.current.clear();
    };
  }, [editorRef, processEvent, processTool]);
  const send = useCallback(
    async (prompt: string) => {
      const editor = editorRef.current;
      if (!editor || !currentNote || !prompt.trim() || !ready) return false;
      if (conversationsRef.current[currentNote.id]?.runId) return false;
      const temporaryId = `pending:${crypto.randomUUID()}`;
      const binding = captureRunBinding(editor, temporaryId);
      if (!binding) return false;
      if (binding.noteId !== currentNote.id) {
        releaseRunBinding(editor, binding);
        return false;
      }
      const run: ActiveRun = {
        binding,
        noteId: binding.noteId,
        cancelRequested: false,
      };
      runs.current.set(temporaryId, run);
      const sessionId =
        conversationsRef.current[binding.noteId]?.sessionId ?? null;
      const context = {
        noteId: binding.noteId,
        noteTitle: binding.noteTitle,
        selection: binding.selectionMarkdown,
      };
      updateConversation(binding.noteId, (conversation) => ({
        ...conversation,
        sessionId,
        context,
        runId: temporaryId,
        error: null,
        cancelled: false,
        items: [
          ...conversation.items,
          {
            id: crypto.randomUUID(),
            type: "user",
            text: prompt.trim(),
            ...(binding.selectionMarkdown && {
              selection: clipPreview(binding.selectionMarkdown).markdown,
            }),
          },
        ],
      }));
      try {
        await listenersReady.current;
        if (runs.current.get(temporaryId) !== run) return false;
        const { runId } = await agent.startRun({
          model: model || null,
          uiGuide,
          sessionId,
          prompt: prompt.trim(),
          context,
        });
        if (runs.current.get(temporaryId) !== run) {
          await agent.cancelRun(runId);
          return false;
        }
        runs.current.delete(temporaryId);
        binding.runId = runId;
        runs.current.set(runId, run);
        updateConversation(run.noteId, (conversation) => ({
          ...conversation,
          runId,
        }));
        const waiting = buffered.current;
        buffered.current = [];
        for (const payload of waiting) {
          if ("event" in payload) processEvent(payload);
          else void processTool(payload);
        }
        if (run.cancelRequested && runs.current.has(runId))
          void agent
            .cancelRun(runId)
            .catch((error) =>
              toast.error(
                `Couldn't stop the agent: ${agent.errorMessage(error)}`,
              ),
            );
        return true;
      } catch (error) {
        if (!runs.current.has(temporaryId)) return false;
        runs.current.delete(temporaryId);
        releaseRunBinding(editorRef.current, binding);
        updateConversation(run.noteId, (conversation) => ({
          ...conversation,
          runId: null,
          error: { kind: "other", message: agent.errorMessage(error) },
        }));
        if (!runs.current.size) buffered.current = [];
        return false;
      }
    },
    [
      currentNote,
      editorRef,
      model,
      processEvent,
      processTool,
      ready,
      updateConversation,
    ],
  );
  const stop = useCallback(async () => {
    const id = currentNote && conversationsRef.current[currentNote.id]?.runId;
    if (!id) return;
    const run = runs.current.get(id);
    if (run) run.cancelRequested = true;
    if (id.startsWith("pending:")) return;
    try {
      await agent.cancelRun(id);
    } catch (error) {
      if (run) run.cancelRequested = false;
      toast.error(`Couldn't stop the agent: ${agent.errorMessage(error)}`);
    }
  }, [currentNote]);
  const setModel = useCallback(
    (next: string) => {
      setSavedModel(next);
      persist({ agentModel: next });
    },
    [persist],
  );
  const setWidth = useCallback(
    (value: number, save = true) => {
      const next = clampPanelWidth(value);
      updateWidth(next);
      if (save) persist({ agentPanelWidthPx: next });
    },
    [persist],
  );
  const toggle = useCallback(() => {
    setOpen((value) => !value);
    setFocusComposer((value) => value + 1);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    editorRef.current?.commands.focus();
  }, [editorRef]);
  const newConversation = useCallback(() => {
    if (currentNote && !conversationsRef.current[currentNote.id]?.runId)
      updateConversation(currentNote.id, emptyConversation);
  }, [currentNote, updateConversation]);
  const currentNoteId = currentNote?.id ?? null;
  const openConversation = useCallback(
    async (sessionId: string) => {
      const noteId = currentNoteId;
      if (!noteId || conversationsRef.current[noteId]?.runId) return;
      try {
        const items = parseTranscript(
          await agent.loadConversation(noteId, sessionId),
        );
        if (conversationsRef.current[noteId]?.runId) return;
        updateConversation(noteId, () => ({
          ...emptyConversation(),
          sessionId,
          items,
        }));
      } catch (error) {
        toast.error(
          `Couldn't open that conversation: ${agent.errorMessage(error)}`,
        );
      }
    },
    [currentNoteId, updateConversation],
  );
  // Opening the panel on a note lists its conversations and, the first time,
  // picks up the most recent one where it left off.
  useEffect(() => {
    historyNote.current = open ? currentNoteId : null;
    setHistory([]);
    if (!open || !currentNoteId) return;
    const noteId = currentNoteId;
    let active = true;
    refreshHistory(noteId)
      .then(async (list) => {
        if (!active || conversationsRef.current[noteId] || !list.length) return;
        const items = parseTranscript(
          await agent.loadConversation(noteId, list[0].id),
        );
        if (!active || conversationsRef.current[noteId]) return;
        updateConversation(noteId, () => ({
          ...emptyConversation(),
          sessionId: list[0].id,
          items,
        }));
      })
      .catch((error) => {
        if (active)
          toast.error(
            `Couldn't load this note's conversations: ${agent.errorMessage(error)}`,
          );
      });
    return () => {
      active = false;
    };
  }, [open, currentNoteId, notesFolder, refreshHistory, updateConversation]);
  const signIn = useCallback(async () => {
    setSigningIn(true);
    try {
      await agent.signIn();
      await refreshStatus();
    } catch (error) {
      toast.error(`ChatGPT sign-in: ${agent.errorMessage(error)}`);
    } finally {
      setSigningIn(false);
    }
  }, [refreshStatus]);
  const cancelSignIn = useCallback(async () => {
    try {
      await agent.cancelSignIn();
    } catch (error) {
      toast.error(agent.errorMessage(error));
    }
  }, []);
  const signOut = useCallback(async () => {
    try {
      await agent.signOut();
      await refreshStatus();
    } catch (error) {
      toast.error(agent.errorMessage(error));
    }
  }, [refreshStatus]);
  const acknowledgePlan = useCallback(async () => {
    try {
      await agent.ackPlanNotice();
      await refreshStatus();
    } catch (error) {
      toast.error(agent.errorMessage(error));
    }
  }, [refreshStatus]);
  const conversation = currentNote
    ? (conversations[currentNote.id] ?? emptyConversation())
    : emptyConversation();
  // Only the active run's card can take a decision: a stopped run leaves its
  // unanswered question or proposal in history, where nothing waits on it.
  const { pendingQuestion, pendingEdit } = useMemo(() => {
    let question: QuestionItem | null = null;
    let edit: NoteEditItem | null = null;
    if (conversation.runId)
      for (const item of conversation.items) {
        if (item.type === "question" && item.runId === conversation.runId)
          question = item.answer === null ? item : null;
        if (item.type === "note_edit" && item.runId === conversation.runId)
          edit = item.status === "pending" ? item : null;
      }
    return { pendingQuestion: question, pendingEdit: edit };
  }, [conversation]);
  const answerQuestion = useCallback(
    async (answer: QuestionAnswer) => {
      if (!pendingQuestion || !runs.current.has(pendingQuestion.runId)) return;
      const run = runs.current.get(pendingQuestion.runId)!;
      const { display, output } = describeAnswer(answer);
      try {
        await agent.toolRespond(pendingQuestion.requestId, true, output);
      } catch (error) {
        toast.error(`Couldn't send your answer: ${agent.errorMessage(error)}`);
        return;
      }
      updateConversation(run.noteId, (current) => ({
        ...current,
        items: current.items.map((item) =>
          item.id === pendingQuestion.id && item.type === "question"
            ? { ...item, answer: display }
            : item,
        ),
      }));
    },
    [pendingQuestion, updateConversation],
  );
  const reviewNoteEdit = useCallback(
    async (decision: NoteEditDecision) => {
      const item = pendingEdit;
      const run = item && runs.current.get(item.runId);
      if (!item || !run) return;
      const update = (patch: Partial<NoteEditItem>) =>
        updateConversation(run.noteId, (current) => ({
          ...current,
          items: current.items.map((entry) =>
            entry.id === item.id && entry.type === "note_edit"
              ? { ...entry, ...patch }
              : entry,
          ),
        }));
      let result: { ok: boolean; output: string };
      if (decision.approve) {
        update({ status: "applying" });
        try {
          await agent.applyNoteEdit(item.noteId, item.edits);
          update({ status: "applied", message: null });
          result = {
            ok: true,
            output: `The user approved, and the edit to "${item.title}" is saved.`,
          };
        } catch (error) {
          const message = agent.errorMessage(error);
          update({ status: "failed", message });
          result = {
            ok: false,
            output: `The user approved, but the edit couldn't be saved: ${message}`,
          };
        }
      } else {
        const feedback = decision.feedback?.trim() || null;
        update({ status: "declined", message: feedback });
        result = {
          ok: false,
          output: feedback
            ? `The user declined this edit and said: ${feedback}`
            : "The user declined this edit.",
        };
      }
      try {
        await agent.toolRespond(item.requestId, result.ok, result.output);
      } catch (error) {
        toast.error(`Couldn't tell ChatGPT: ${agent.errorMessage(error)}`);
      }
    },
    [pendingEdit, updateConversation],
  );
  const value = useMemo<AgentContextValue>(
    () => ({
      open,
      toggle,
      close,
      focusComposer,
      width,
      setWidth,
      model,
      setModel,
      models,
      modelsLoading,
      modelsError,
      reloadModels,
      status,
      statusLoading,
      statusError,
      refreshStatus,
      pendingQuestion,
      answerQuestion,
      pendingEdit,
      reviewNoteEdit,
      conversation,
      send,
      stop,
      newConversation,
      history,
      openConversation,
      signingIn,
      signIn,
      cancelSignIn,
      signOut,
      acknowledgePlan,
      editor,
    }),
    [
      open,
      toggle,
      close,
      focusComposer,
      width,
      setWidth,
      model,
      setModel,
      models,
      modelsLoading,
      modelsError,
      reloadModels,
      status,
      statusLoading,
      statusError,
      refreshStatus,
      pendingQuestion,
      answerQuestion,
      pendingEdit,
      reviewNoteEdit,
      conversation,
      send,
      stop,
      newConversation,
      history,
      openConversation,
      signingIn,
      signIn,
      cancelSignIn,
      signOut,
      acknowledgePlan,
      editor,
    ],
  );
  return (
    <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
  );
}
export function useAgent() {
  const value = useContext(AgentContext);
  if (!value) throw new Error("useAgent requires AgentProvider");
  return value;
}
