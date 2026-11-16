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
import {
  captureRunBinding,
  releaseRunBinding,
  executeDocumentTool,
  type RunBinding,
} from "../lib/agent/documentTools";

export type TranscriptItem =
  | { id: string; type: "user" | "text"; text: string }
  | {
      id: string;
      type: "tool";
      name: string;
      input: unknown;
      ok?: boolean;
      output?: string;
    };
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
  conversation: Conversation;
  send: (prompt: string) => Promise<boolean>;
  stop: () => Promise<void>;
  newConversation: () => void;
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
        if (event.type === "tool_call")
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
        if (event.type === "error" && event.kind === "auth")
          void refreshStatus();
      }
    },
    [editorRef, refreshStatus, updateConversation],
  );
  const processTool = useCallback(
    async (request: agent.ToolRequest) => {
      const run = runs.current.get(request.runId);
      if (!run) {
        if ([...runs.current.keys()].some((id) => id.startsWith("pending:")))
          buffered.current.push(request);
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
    [editorRef],
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
          { id: crypto.randomUUID(), type: "user", text: prompt.trim() },
        ],
      }));
      try {
        await listenersReady.current;
        if (runs.current.get(temporaryId) !== run) return false;
        const { runId } = await agent.startRun({
          model: model || null,
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
      conversation,
      send,
      stop,
      newConversation,
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
      conversation,
      send,
      stop,
      newConversation,
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
