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
import { useCoeditingObserver } from "../lib/agent/useCoeditingObserver";
import { clearAgentPresence } from "../components/editor/AgentChanges";
import { noteEditChange, type NoteChange } from "../lib/agent/turnChanges";
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
  | { id: string; type: "activity"; text: string }
  | { id: string; type: "changes"; change: NoteChange }
  | ({ id: string; type: "skill_offer"; dismissed?: boolean } & agent.SkillOffer);
export type QuestionItem = Extract<TranscriptItem, { type: "question" }>;
export type SkillOfferItem = Extract<TranscriptItem, { type: "skill_offer" }>;
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
const TRANSCRIPT_TYPES: Record<string, true> = {
  user: true, text: true, tool: true, question: true, activity: true, changes: true,
  skill_offer: true,
};
/** An offer card reads all of these; a saved item missing any is not shown. */
const isSkillOffer = (item: Record<string, unknown>) =>
  ["name", "description", "source", "content", "digest"].every(
    (key) => typeof item[key] === "string",
  ) &&
  Array.isArray(item.files) &&
  typeof item.archive === "boolean";
/** A saved transcript, keeping only items this version knows how to show. */
function parseTranscript(value: unknown): TranscriptItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is TranscriptItem =>
      !!item &&
      typeof item === "object" &&
      typeof item.id === "string" &&
      typeof item.type === "string" && TRANSCRIPT_TYPES[item.type] === true &&
      (item.type !== "skill_offer" || isSkillOffer(item)),
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
  conversation: Conversation;
  send: (prompt: string, computerAccess?: boolean) => Promise<boolean>;
  stop: () => Promise<void>;
  coediting: boolean;
  resumeCoediting: () => void;
  computerAccess: boolean;
  setComputerAccess: (enabled: boolean) => void;
  /** Internet access: the research role and skill offers. */
  webAccess: boolean;
  setWebAccess: (enabled: boolean) => void;
  /** The research role's model: the saved one, else Luna, else `model`. */
  researchModel: string;
  setResearchModel: (model: string) => void;
  /** The user's brief for the research role; null means the built-in one. */
  researchBrief: string | null;
  setResearchBrief: (brief: string | null) => void;
  dismissSkillOffer: (id: string) => void;
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
  const [computerAccess, updateComputerAccess] = useState(true);
  const [webAccess, updateWebAccess] = useState(true);
  const [savedResearchModel, setSavedResearchModel] = useState<string | null>(null);
  const [researchBrief, updateResearchBrief] = useState<string | null>(null);
  const [coeditingSession, setCoeditingSession] = useState<number | null>(null);
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
  const transcriptQueue = useRef(Promise.resolve());
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
      transcriptQueue.current = transcriptQueue.current
        .then(async () => {
          await agent.saveConversation(conversation.sessionId!, conversation.items);
          if (historyNote.current) await refreshHistory(historyNote.current);
        })
        .catch((error) => {
          toast.error(`Couldn't save this conversation: ${agent.errorMessage(error)}`);
        });
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
    setSavedResearchModel(null);
    updateResearchBrief(null);
    setCoeditingSession(null);
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
        updateComputerAccess(settings.agentComputerAccess ?? true);
        updateWebAccess(settings.agentWebAccess ?? true);
        setSavedResearchModel(settings.agentResearchModel ?? null);
        updateResearchBrief(settings.agentResearchBrief ?? null);
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
  useEffect(() => {
    if (!editor) return;
    for (const [runId, run] of runs.current) {
      if (run.binding.documentSession === editor.storage.scratchDocument.session) continue;
      run.cancelRequested = true;
      if (!runId.startsWith("pending:"))
        void agent.cancelRun(runId).catch((error) =>
          toast.error(`Couldn't stop the previous note's agent: ${agent.errorMessage(error)}`));
    }
  }, [currentNote?.id, editor]);
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
  // Research defaults to Luna, the light model, when the account lists one.
  const researchModel = models.some((item) => item.id === savedResearchModel)
    ? (savedResearchModel ?? "")
    : (models.find((item) => item.id.includes("luna"))?.id ?? model);
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
        // Questions show as cards; edits appear in the activity log.
        if (event.type === "tool_call" && event.name !== "ask_user")
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
        if (event.type === "tool_result") {
          const toolId = `${payload.runId}:${event.callId}`;
          const items = conversation.items.map((item) =>
            item.id === toolId && item.type === "tool"
              ? { ...item, ok: event.ok, output: event.output }
              : item,
          );
          const tool = items.find((item) => item.id === toolId);
          const change = event.ok && tool?.type === "tool" && tool.name === "edit_note"
            ? noteEditChange(tool.input) : null;
          if (change && !items.some((item) => item.id === `${toolId}:changes`))
            items.push({ id: `${toolId}:changes`, type: "changes", change });
          return { ...conversation, items };
        }
        if (event.type === "skill_offer") {
          const { type: _type, ...offer } = event;
          // One card per download of a skill, however often it is offered. The
          // digest covers an archive's bundled files as well as its instructions.
          if (conversation.items.some((item) =>
            item.type === "skill_offer" && item.source === offer.source && item.digest === offer.digest))
            return conversation;
          return {
            ...conversation,
            items: [...conversation.items, { id: crypto.randomUUID(), type: "skill_offer", ...offer }],
          };
        }
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
      if (event.type === "tool_result" &&
          conversationsRef.current[run.noteId]?.items.some((item) =>
            item.type === "tool" && item.id === `${payload.runId}:${event.callId}` &&
            ["edit_document", "replace_selection", "edit_note"].includes(item.name)))
        saveConversation(run.noteId);
      // Keep the offer if the run is interrupted before its reply.
      if (event.type === "skill_offer") saveConversation(run.noteId);
      if (event.type === "done" || event.type === "error") {
        releaseRunBinding(editorRef.current, run.binding,
          event.type === "done" && event.stopReason === "completed" && !run.cancelRequested);
        if (event.type === "error" || event.stopReason === "cancelled")
          setCoeditingSession((session) => session === run.binding.documentSession ? null : session);
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
      let result: Awaited<ReturnType<typeof executeDocumentTool>>;
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
      if (result.ok && result.change?.hunks.length) {
        const change = result.change;
        updateConversation(run.noteId, (conversation) => ({
          ...conversation,
          items: [...conversation.items, { id: `${request.requestId}:changes`, type: "changes", change }],
        }));
        // Keep applied changes even if the run is interrupted before its reply.
        saveConversation(run.noteId);
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
    async (prompt: string, allowComputer = computerAccess, checkIn = false) => {
      const editor = editorRef.current;
      if (!editor || !currentNote || !prompt.trim() || !ready) return false;
      if (conversationsRef.current[currentNote.id]?.runId) return false;
      const temporaryId = `pending:${crypto.randomUUID()}`;
      const binding = captureRunBinding(editor, temporaryId, !checkIn);
      if (!binding) return false;
      if (binding.noteId !== currentNote.id) {
        releaseRunBinding(editor, binding);
        return false;
      }
      setCoeditingSession(binding.documentSession);
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
        computerAccess: allowComputer,
        webAccess,
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
            type: checkIn ? "activity" : "user",
            text: checkIn ? "You edited the note. Checking in…" : prompt.trim(),
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
          computerAccess: allowComputer,
          webAccess,
          researchModel: researchModel || null,
          researchBrief,
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
        setCoeditingSession(null);
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
      computerAccess,
      editorRef,
      model,
      webAccess,
      researchModel,
      researchBrief,
      processEvent,
      processTool,
      ready,
      updateConversation,
    ],
  );
  const stop = useCallback(async () => {
    setCoeditingSession(null);
    if (editorRef.current) clearAgentPresence(editorRef.current);
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
  }, [currentNote, editorRef]);
  const setComputerAccess = useCallback((enabled: boolean) => {
    updateComputerAccess(enabled);
    persist({ agentComputerAccess: enabled });
    if (!enabled) void stop();
  }, [persist, stop]);
  const setWebAccess = useCallback((enabled: boolean) => {
    updateWebAccess(enabled);
    persist({ agentWebAccess: enabled });
  }, [persist]);
  const setResearchModel = useCallback((next: string) => {
    setSavedResearchModel(next);
    persist({ agentResearchModel: next });
  }, [persist]);
  const setResearchBrief = useCallback((brief: string | null) => {
    const next = brief?.trim() || null;
    updateResearchBrief(next);
    persist({ agentResearchBrief: next ?? undefined });
  }, [persist]);
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
  const close = useCallback(() => {
    void stop();
    setOpen(false);
    const source = document.querySelector<HTMLTextAreaElement>("[data-note-source]");
    if (source) source.focus({ preventScroll: true });
    else editorRef.current?.commands.focus(undefined, { scrollIntoView: false });
  }, [editorRef, stop]);
  const toggle = useCallback(() => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    setFocusComposer((value) => value + 1);
  }, [open, close]);
  const newConversation = useCallback(() => {
    if (!currentNote || conversationsRef.current[currentNote.id]?.runId) return;
    setCoeditingSession(null);
    if (editorRef.current) clearAgentPresence(editorRef.current);
    updateConversation(currentNote.id, emptyConversation);
  }, [currentNote, editorRef, updateConversation]);
  const currentNoteId = currentNote?.id ?? null;
  const dismissSkillOffer = useCallback(
    (id: string) => {
      if (!currentNoteId) return;
      updateConversation(currentNoteId, (conversation) => ({
        ...conversation,
        items: conversation.items.map((item) =>
          item.id === id && item.type === "skill_offer"
            ? { ...item, dismissed: true }
            : item,
        ),
      }));
      saveConversation(currentNoteId);
    },
    [currentNoteId, saveConversation, updateConversation],
  );
  const openConversation = useCallback(
    async (sessionId: string) => {
      const noteId = currentNoteId;
      if (!noteId || conversationsRef.current[noteId]?.runId) return;
      setCoeditingSession(null);
      if (editorRef.current) clearAgentPresence(editorRef.current);
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
    [currentNoteId, editorRef, updateConversation],
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
      setCoeditingSession(null);
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
  const pendingQuestion = useMemo(() => {
    let question: QuestionItem | null = null;
    if (conversation.runId)
      for (const item of conversation.items)
        if (item.type === "question" && item.runId === conversation.runId)
          question = item.answer === null ? item : null;
    return question;
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
  const coediting = open && coeditingSession !== null &&
    coeditingSession === editor?.storage.scratchDocument.session;
  const resumeCoediting = useCallback(() => {
    if (editor && ready) setCoeditingSession(editor.storage.scratchDocument.session);
  }, [editor, ready]);
  const checkIn = useCallback(() => {
    const observe = async () => {
      if (!coediting || !editor || editor.isDestroyed) return;
      if (pendingQuestion) {
        const run = runs.current.get(pendingQuestion.runId);
        if (!run || run.cancelRequested) return;
        try {
          await agent.toolRespond(pendingQuestion.requestId, true,
            "The user edited the live document while you waited. This is not an answer to your question. Read the document again, respect their changes, and continue if they resolve your question. Otherwise ask only if you are blocked.");
          updateConversation(run.noteId, (current) => ({
            ...current,
            items: current.items.map((item) =>
              item.id === pendingQuestion.id && item.type === "question"
                ? { ...item, answer: "Continued after your document edit." }
                : item),
          }));
        } catch (error) {
          setCoeditingSession(null);
          toast.error(`Couldn't notify the agent: ${agent.errorMessage(error)}`);
        }
        return;
      }
      await send(
        "Document activity: the user edited the live note. Read the current document before acting. Respect their changes and continue the existing collaboration where useful. Do not revert their choices or invent a new task. Check in briefly only if you have something useful to add; otherwise finish without a message.",
        computerAccess,
        true,
      );
    };
    void observe();
  }, [coediting, editor, pendingQuestion, send, computerAccess, updateConversation]);
  useCoeditingObserver(editor, coediting, !!conversation.runId && !pendingQuestion, checkIn);
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
      coediting,
      resumeCoediting,
      computerAccess,
      setComputerAccess,
      webAccess,
      setWebAccess,
      researchModel,
      setResearchModel,
      researchBrief,
      setResearchBrief,
      dismissSkillOffer,
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
      coediting,
      resumeCoediting,
      computerAccess,
      setComputerAccess,
      webAccess,
      setWebAccess,
      researchModel,
      setResearchModel,
      researchBrief,
      setResearchBrief,
      dismissSkillOffer,
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
