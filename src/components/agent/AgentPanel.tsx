import { WorkingMemory } from "./WorkingMemory";
import { McpServices } from "./McpServices";
import { AntigravitySignIn } from "./AntigravitySignIn";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useMemo,
  useState,
} from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  useAgent,
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  clampPanelWidth,
  type QuestionAnswer,
} from "../../context/AgentContext";
import { useAgentDocument } from "../../context/AgentDocumentContext";
import { useSkills } from "../../context/SkillsContext";
import { completeSkill, invokedSkill, matchSkills, skillQuery } from "../../lib/agent/skillCommand";
import { SkillMenu, skillOptionId } from "./SkillMenu";
import {
  activeFocusRange,
  attachedRange,
  detachSelection,
  scrollPositionIntoView,
  useAgentChanges,
} from "../editor/AgentChanges";
import {
  summarizeMarkdown,
  summarizeRange,
  type SelectionSummary,
} from "../../lib/agent/selection";
import {
  AntigravityIcon,
  ChatGPTIcon,
  CheckIcon,
  EyeIcon,
  HelpCircleIcon,
  HistoryIcon,
  SearchIcon,
  WorkflowIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  PlusIcon,
  SpinnerIcon,
  StopIcon,
  XIcon,
} from "../icons";
import { IconButton, Tooltip } from "../ui";
import { formatDate } from "../../lib/utils";
import { AgentMessage } from "./AgentMessage";
import { ContinueWithChatGPT, ManageUsage, PlanNotice } from "./ChatGPTAccount";
import { AgentTurnChanges, conversationTurns } from "./AgentTurnChanges";
import { OpenNoteContext, SuggestionContext } from "./ui/registry";
import { ComputerPermissions } from "./ComputerPermissions";
import { SelectionCard, type SelectionAction } from "./SelectionCard";
import { WritingOfferCard, WritingOfferContext, hasWritingOfferCard, type WritingOfferControls } from "./WritingOfferCard";
import { surfaceFromRecord, TraceLookupContext, TraceReopenContext } from "./ui/writingOfferContext";
import { mapStepBlock, writingOfferChatText, type WritingRequest } from "../../lib/agent/writingOffers";
import { isAntigravityModel, type WritingScores } from "../../services/agent";
import { confidentIntent, inlineAgentPrompt, leavesRequestOpen, routeMessage, type ResponseMode } from "../../lib/agent/inlineDecision";
import { agentPresence, displayInstruction } from "./InlineAgentActivity";
import { InlineAgentFace } from "./InlineAgentFace";
import { ModelPicker } from "./ModelPicker";
import { WritingCompanionPointer } from "./WritingCompanionPointer";
import { AgentWorking, useLingering } from "./AgentWorking";
import { ArgumentMapOverlay } from "./ArgumentMapOverlay";
import { argumentMapFor } from "../editor/ArgumentMap";

/** Each way to work together, and which of the gate's scores says it fits this passage. */
const STARTERS: Array<{ label: string; kind: WritingRequest; fits: (scores: WritingScores) => number }> = [
  { label: "Show a version", kind: "rewrite", fits: (scores) => scores.clarity },
  { label: "Trace my argument", kind: "question", fits: (scores) => Math.max(scores.clarity, scores.development) },
  { label: "Check a claim", kind: "evidence", fits: (scores) => scores.evidence },
  { label: "Read it back", kind: "readback", fits: (scores) => scores.clarity },
  { label: "Compare versions", kind: "compare", fits: (scores) => scores.development },
  { label: "Explore the order", kind: "move", fits: (scores) => scores.development },
];
/** What the agent can do with a highlighted passage, tracing it first. */
const SELECTION_ACTIONS: Array<Omit<SelectionAction, "onSelect"> & {
  kind: WritingRequest | "interview";
  /** What the working indicator says while it's under way. */
  doing: string;
}> = [
  { label: "Trace argument", title: "Trace this argument", icon: WorkflowIcon, kind: "outcome", doing: "Tracing the argument" },
  { label: "Ask me questions", title: "Ask me questions, then improve it", icon: HelpCircleIcon, kind: "interview", doing: "Thinking of questions" },
  { label: "Check claim", title: "Check a claim", icon: SearchIcon, kind: "evidence", doing: "Checking the claim" },
  { label: "Read back", title: "Read it back as your reader", icon: EyeIcon, kind: "readback", doing: "Reading as your reader" },
];
/** How long a reply may pause before the panel shows the agent working instead of a caret. */
const FLOW_PAUSE_MS = 1500;
/** The working indicator stays this long once shown, so a run trading tools and text doesn't blink. */
const WORKING_MIN_MS = 600;
/** And fades out over this long. */
const WORKING_EXIT_MS = 160;
/** What the writer is shown as having asked; the interview's instructions travel with it. */
const INTERVIEW_REQUEST = "Ask me a few questions about this passage, then improve it with my answers.";
/** A starter is marked as fitting once its score says help is more likely useful than not. */
const FITTING_STARTER = 0.5;

/** The standing starters, best fit first; ties keep their usual order. */
export function orderedStarters(scores: WritingScores | null) {
  const ranked = STARTERS.map((starter) => ({ ...starter, score: scores ? starter.fits(scores) : 0 }));
  ranked.sort((a, b) => b.score - a.score);
  return ranked.map((starter, index) => ({ ...starter, fitting: index === 0 && starter.score >= FITTING_STARTER }));
}
function ResizeHandle() {
  const { width, setWidth } = useAgent();
  const drag = useRef<{ x: number; width: number; current: number } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  useEffect(
    () => () => {
      if (drag.current) setWidth(drag.current.width, false);
    },
    [setWidth],
  );
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize agent panel"
      aria-valuemin={PANEL_MIN}
      aria-valuemax={PANEL_MAX}
      aria-valuenow={width}
      tabIndex={0}
      className={`agent-panel-resize ${dragging ? "agent-panel-resizing" : ""}`}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width, current: width };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        drag.current.current = clampPanelWidth(
          drag.current.width + drag.current.x - event.clientX,
        );
        setWidth(drag.current.current, false);
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        const { current, width: initial } = drag.current;
        drag.current = null;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (current !== initial) setWidth(current);
      }}
      onPointerCancel={() => {
        if (drag.current) setWidth(drag.current.width, false);
        drag.current = null;
        setDragging(false);
      }}
      onDoubleClick={() => setWidth(PANEL_DEFAULT)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16;
        const next =
          event.key === "ArrowLeft"
            ? width + step
            : event.key === "ArrowRight"
              ? width - step
              : event.key === "Home"
                ? PANEL_MIN
                : event.key === "End"
                  ? PANEL_MAX
                  : null;
        if (next !== null) {
          event.preventDefault();
          setWidth(next);
        }
      }}
    >
      <span />
    </div>
  );
}
export function AgentPanel({
  visible,
  onManageServers,
}: {
  visible: boolean;
  /** Opens settings on the MCP servers tab. */
  onManageServers?: () => void;
}) {
  const agent = useAgent();
  const { currentNote, selectNote } = useAgentDocument();
  const changes = useAgentChanges(agent.editor);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<SelectionSummary | null>(null);
  // The run's selection as it maps through edits, for its section and scrolling.
  const [focusRange, setFocusRange] = useState<{ from: number; to: number } | null>(null);
  const [reviewIndex, setReviewIndex] = useState(-1);
  const [sending, setSending] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composerBox = useRef<HTMLDivElement>(null);
  // The `/` skill menu: where the caret is, which row is highlighted, and
  // whether Escape closed it until the writer types again.
  const [caret, setCaret] = useState(0);
  const [skillIndex, setSkillIndex] = useState(0);
  const [skillMenuClosed, setSkillMenuClosed] = useState(false);
  const skillListId = useId();
  const { skills } = useSkills();
  const scroll = useRef<HTMLDivElement>(null);
  const status = agent.status;
  const conversation = agent.conversation;
  // A sent message carries note context for the model; show only what the user typed.
  const turns = useMemo(() => conversationTurns(conversation.items).map((turn) => ({
    ...turn,
    items: turn.items.map((item) => item.type === "user" ? { ...item, text: displayInstruction(item.text) } : item),
  })), [conversation.items]);
  const home = useRef<HTMLSpanElement>(null);
  const [pointerReplay, setPointerReplay] = useState(0);
  const offerInTranscript = useMemo(() => !!agent.writingOffer && hasWritingOfferCard(conversation.items, agent.writingOffer.id), [conversation.items, agent.writingOffer?.id]);
  const running = conversation.runId !== null;
  const contextTitle = running
    ? conversation.context?.noteTitle
    : currentNote?.title;
  const runSelection = conversation.context?.selection ?? null;
  const selectionSummary = useMemo(
    () =>
      running
        ? runSelection
          ? summarizeMarkdown(runSelection, agent.editor, focusRange)
          : null
        : selection,
    [running, runSelection, agent.editor, focusRange, selection],
  );
  const draft = currentNote ? (drafts[currentNote.id] ?? "") : "";
  const codexReady = status?.status === "ready";
  const antigravityReady = !!agent.antigravityEnabled && agent.antigravityStatus?.status === "ready";
  const anyReady = codexReady || antigravityReady;
  const usingAntigravity = isAntigravityModel(agent.model);
  const needsPlanNotice =
    !usingAntigravity && status?.account?.planUsage && !status.account.planNoticeSeen;
  const showChatGptSignIn = status?.status === "signed_out" && !antigravityReady;
  const reason = !currentNote
    ? "Open a note to start a conversation."
    : !anyReady && (agent.statusLoading || agent.antigravityLoading)
      ? agent.antigravityEnabled && !agent.statusLoading
        ? "Checking Antigravity…"
        : "Checking your ChatGPT account…"
      : !anyReady && !status
        ? (agent.statusError ?? "ChatGPT is unavailable. Try again.")
        : !anyReady
          ? (status?.detail ??
            (status?.status === "signed_out"
              ? "Sign in with ChatGPT to get started."
              : "Codex is unavailable. Try again."))
          : needsPlanNotice
            ? "Confirm ChatGPT plan use above to continue."
            : agent.modelsLoading
              ? "Loading models…"
              : agent.modelsError;
  useEffect(() => {
    const editor = agent.editor;
    if (!editor) {
      setSelection(null);
      setFocusRange(null);
      return;
    }
    // Runs on every transaction, so only store values that actually changed:
    // an equal state keeps the panel from re-rendering on each keystroke.
    let summarized = editor.state.doc;
    const update = () => {
      const { doc } = editor.state;
      const attached = attachedRange(editor);
      setSelection((previous) => {
        if (!attached) return null;
        if (
          doc === summarized &&
          previous?.range?.from === attached.from &&
          previous.range.to === attached.to
        )
          return previous;
        summarized = doc;
        return summarizeRange(editor, attached.from, attached.to);
      });
      const range = activeFocusRange(editor);
      setFocusRange((previous) =>
        previous?.from === range?.from && previous?.to === range?.to
          ? previous
          : range && { from: range.from, to: range.to },
      );
    };
    update();
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
  }, [agent.editor, currentNote?.id]);
  const revealSelection = useCallback(() => {
    if (agent.editor && selectionSummary?.range)
      scrollPositionIntoView(agent.editor, selectionSummary.range.from);
  }, [agent.editor, selectionSummary]);
  const clearSelection = useCallback(() => {
    if (agent.editor) detachSelection(agent.editor);
  }, [agent.editor]);
  // Focus moves only on an explicit request (toggle, ⌘⌥→), never when the
  // account check, a send or a run settles after the user has moved on.
  // Returning to the note before the frame withdraws the request.
  const { composerFocusRequest, takeComposerFocus } = agent;
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (takeComposerFocus()) composer.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [composerFocusRequest, takeComposerFocus]);
  useLayoutEffect(() => {
    if (visible && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [visible, conversation.items, conversation.error, conversation.computerUnavailable, conversation.cancelled, running, agent.writingOffer?.id, agent.writingSuggestion]);
  // The composer grows when its pills return after a send, shrinking the log.
  // A log resting at its end stays there, so the newest message isn't covered.
  useEffect(() => {
    const log = scroll.current;
    if (!log) return;
    let atEnd = true;
    const onScroll = () => {
      atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
    };
    const observer = new ResizeObserver(() => {
      if (atEnd) log.scrollTop = log.scrollHeight;
    });
    log.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(log);
    return () => {
      log.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    setReviewIndex(-1);
  }, [currentNote?.id]);
  const { pendingQuestion, answerQuestion } = agent;
  const waiting = !!pendingQuestion;
  // While the agent works on a request, a message redirects it instead of waiting its turn.
  const steering = running && !agent.companionChecking && !waiting;
  // Text is flowing while the latest reply grew moments ago. A reply that has
  // stopped growing, or an older one under a new run, gets the working
  // indicator instead of a caret promising words that aren't coming.
  const lastItem = conversation.items[conversation.items.length - 1];
  const lastText = lastItem?.type === "text" ? lastItem.text : null;
  const seenText = useRef(lastText);
  const [flowing, setFlowing] = useState(false);
  useEffect(() => {
    const grew = running && !!lastText && lastText !== seenText.current;
    seenText.current = lastText;
    setFlowing(grew);
    if (!grew) return;
    const timer = setTimeout(() => setFlowing(false), FLOW_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [running, lastText]);
  // A background check shows only on the face in the header; the transcript
  // shows work the writer asked for.
  // Requested help shows from the click, before its run starts.
  const working = (running || sending || agent.companionRequested) && !waiting &&
    (!agent.companionChecking || agent.companionRequested);
  const workingPhase = useLingering(working && !flowing, WORKING_MIN_MS, WORKING_EXIT_MS);
  // A reply that paused mid-stream: the agent is between sentences or tools.
  const stalled = running && lastText !== null;
  const [workStart, setWorkStart] = useState(() => Date.now());
  useEffect(() => {
    if (working) setWorkStart(Date.now());
  }, [working]);
  // What the writer asked for from the highlight, named while it's prepared.
  const [asked, setAsked] = useState<string | null>(null);
  useEffect(() => {
    if (asked && !agent.companionRequested && !sending) setAsked(null);
  }, [asked, agent.companionRequested, sending]);
  const sendLabel = pendingQuestion ? "Send answer" : steering ? "Steer agent" : "Send message";
  // A skill starts a request, so answers and steering stay plain text.
  const offersSkills = visible && !!currentNote && !pendingQuestion && !steering && skills !== null;
  const typedSkill = offersSkills && !skillMenuClosed ? skillQuery(draft, caret) : null;
  const skillMatches = useMemo(
    () => (typedSkill === null || !skills ? [] : matchSkills(skills, typedSkill)),
    [skills, typedSkill],
  );
  const skillMenuOpen = typedSkill !== null;
  const highlightedSkill = Math.min(skillIndex, Math.max(0, skillMatches.length - 1));
  const invoked = offersSkills ? invokedSkill(draft, skills) : null;
  const setDraft = (text: string) => {
    if (currentNote) setDrafts((previous) => ({ ...previous, [currentNote.id]: text }));
  };
  const pickSkill = (name: string) => {
    const next = completeSkill(draft, name);
    setDraft(next.text);
    setCaret(next.caret);
    // The value lands on the next render; put the caret after the command then.
    requestAnimationFrame(() => {
      composer.current?.focus({ preventScroll: true });
      composer.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const answer = useCallback(
    (value: QuestionAnswer) => {
      void answerQuestion(value);
    },
    [answerQuestion],
  );
  const openNote = useCallback(
    (id: string) => {
      void selectNote(id);
    },
    [selectNote],
  );
  const submit = async () => {
    if (!currentNote || reason || sending || !draft.trim()) return;
    const id = currentNote.id;
    if (pendingQuestion) {
      const text = draft.trim();
      setDrafts((previous) => ({ ...previous, [id]: "" }));
      await answerQuestion(text);
      return;
    }
    const text = draft;
    const skill = invoked;
    setDrafts((previous) => ({ ...previous, [id]: "" }));
    // A background writing check gives way to a message; any other run is steered by it.
    if (steering) {
      if (!(await agent.steer(text))) setDrafts((previous) => ({ ...previous, [id]: previous[id] || text }));
      return;
    }
    await deliver(text, () => setDrafts((previous) => ({ ...previous, [id]: previous[id] || text })), { skill });
  };
  /**
   * Route and send one message; `restore` puts it back if it never left. A
   * message invoking a skill skips routing: the skill, not the classifier,
   * says what kind of work it is, and it runs on the model the writer chose.
   * So does one sent in a mode the panel already knows, such as an interview.
   */
  const deliver = async (text: string, restore: () => void,
    { skill = null, mode }: { skill?: string | null; mode?: ResponseMode } = {}) => {
    const editor = agent.editor;
    setSending(true);
    try {
      if (!editor) {
        if (!(await agent.send(text))) restore();
        return;
      }
      const session = editor.storage.scratchDocument.session;
      agent.prepareCompanionMessage();
      const decision = codexReady && !usingAntigravity && !skill && !mode
        ? await routeMessage(editor, text, conversation.items)
        : null;
      // The note changed while routing: this message was never meant for the new one.
      if (editor.isDestroyed || editor.storage.scratchDocument.session !== session) {
        restore();
        return;
      }
      const sent = await agent.send(inlineAgentPrompt(editor, text, mode ?? confidentIntent(decision)), undefined, "coedit",
        { route: decision?.route, openRequest: leavesRequestOpen(decision), ...(skill ? { skill } : {}) });
      if (!sent) restore();
    } finally {
      setSending(false);
    }
  };
  // A suggestion goes out as its own message and leaves a half-written draft alone.
  const sendSuggestion = !reason && !sending && !running && !waiting
    ? (message: string) => { void deliver(message, () => {}); }
    : null;
  const starters = useMemo(() => orderedStarters(agent.writingScores), [agent.writingScores]);
  const selectionRange = selectionSummary?.range;
  // Each action works on the highlight itself, not the passage around the cursor.
  // An interview is a request to edit it, so it goes to the main agent; the rest are read-only offers.
  const selectionActions: SelectionAction[] = selectionRange && !reason
    ? SELECTION_ACTIONS.map(({ kind, doing, ...action }) => ({
        ...action, onSelect: () => {
          setAsked(doing);
          if (kind === "interview") void deliver(INTERVIEW_REQUEST, () => {}, { mode: "interview" });
          else void agent.requestWritingHelp(kind, { focus: selectionRange });
        },
      }))
    : [];
  // Where the agent's attention is: the passage a run was sent with, or the
  // highlight the writer asked about.
  const workTarget = selectionSummary ?? (agent.companionRequested ? selection : null);
  const workRange = workTarget?.range;
  const showWorkTarget = useCallback(() => {
    if (agent.editor && workRange) scrollPositionIntoView(agent.editor, workRange.from);
  }, [agent.editor, workRange]);
  const presence = agentPresence(agent, sending);
  const suggestion = agent.writingSuggestion;
  const navigate = (direction: number) => {
    const next =
      reviewIndex < 0
        ? direction > 0
          ? 0
          : changes.length - 1
        : (reviewIndex + direction + changes.length) % changes.length;
    setReviewIndex(next);
    agent.editor?.commands.scrollToAgentChange(changes[next].id);
  };
  const traceLookup = useCallback((offerId: string) => {
    for (let idx = conversation.items.length - 1; idx >= 0; idx--) {
      const item = conversation.items[idx];
      if (item.type === "trace" && (item.offerId === offerId || item.id === offerId))
        return surfaceFromRecord(item);
    }
    return null;
  }, [conversation.items]);
  const offer = agent.writingOffer;
  const offerControls: WritingOfferControls | null = offer ? {
    id: offer.id, offer: offer.prepared, stale: offer.stale, busy: running || sending || waiting || agent.companionChecking || !!reason,
    draft: agent.writingOfferDraft, onDraftChange: agent.setWritingOfferDraft,
    onAccept: agent.acceptWritingOffer,
    onAnswer: (answer) => { void agent.requestWritingHelp("question", { answer }); },
    onShow: agent.showWritingOffer,
    onHighlight: agent.highlightWritingOffer,
    map: { open: !!agent.argumentMap, active: agent.argumentMap?.active ?? null,
      playing: !!agent.argumentMap?.playing, onPlay: agent.playArgumentMap, onToggle: agent.toggleArgumentMap,
      onFocus: agent.focusArgumentStep,
      onConfirm: agent.confirmArgumentStep,
      onCheckSource: (step) => { void agent.requestWritingHelp("evidence", { step }); },
      onRealign: (step, correction) => { void agent.requestWritingHelp("realign", { answer: correction, step }); } },
    onDismiss: agent.dismissWritingSuggestion,
    onAddToChat: () => {
      if (!currentNote) return;
      const context = writingOfferChatText(offer.prepared, agent.writingOfferDraft);
      setDrafts((previous) => ({ ...previous, [currentNote.id]: previous[currentNote.id]?.trim()
        ? `${previous[currentNote.id]}\n\n${context}` : context }));
      composer.current?.focus({ preventScroll: true });
    },
  } : null;
  return (
    <aside
      className={`agent-panel ${visible ? "agent-panel-open" : ""}`}
      style={{ width: visible ? agent.width : 0 }}
      aria-label="Agent"
      aria-hidden={!visible}
      inert={!visible}
    >
      {visible && <ResizeHandle />}
      {visible && agent.editor && agent.writingFocus && agent.writingTarget && (
        <WritingCompanionPointer
          key={offer?.id ?? "writing-finding"}
          editor={agent.editor} range={agent.writingTarget} kind={agent.writingFocus}
          preparedOffer={offer && !offer.stale ? offer.prepared : null}
          originRef={home} replayTrigger={pointerReplay + agent.writingOfferReplay}
          followTarget={agent.argumentMap && offer && !offer.stale
            ? mapStepBlock(agent.editor.state.doc, offer.prepared, agent.argumentMap.active) : null} />
      )}
      {visible && agent.editor && offer && !offer.stale && agent.argumentMap && (
        <ArgumentMapOverlay editor={agent.editor} trace={offer.prepared.offer.trace}
          map={argumentMapFor(offer.prepared, agent.argumentMap.active)}
          onSelect={agent.focusArgumentStep} />
      )}
      <div className="agent-panel-inner" style={{ width: agent.width }}>
        <header className="agent-panel-header">
          <span ref={home} className="shrink-0">
            <InlineAgentFace state={presence.state} expression={presence.expression} />
          </span>
          <ModelPicker
            ready={anyReady}
            disabled={running}
            modelsLoading={agent.modelsLoading}
            model={agent.model}
            models={agent.models}
            onSelectModel={agent.setModel}
            effort={agent.effort ?? ""}
            efforts={agent.efforts ?? []}
            onSelectEffort={agent.setEffort}
            priorityMode={!!agent.priorityMode}
            supportsPriority={!!agent.supportsPriority}
            priorityDescription={agent.priorityDescription ?? null}
            onTogglePriority={agent.setPriorityMode}
          />
          <DropdownMenu.Root>
            <Tooltip content="Earlier conversations">
              <DropdownMenu.Trigger asChild>
                <IconButton
                  tabIndex={0}
                  aria-label="Earlier conversations"
                  disabled={running || !agent.history.length}
                >
                  <HistoryIcon className="w-4 h-4" />
                </IconButton>
              </DropdownMenu.Trigger>
            </Tooltip>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="agent-panel-history"
                sideOffset={5}
                align="end"
              >
                <DropdownMenu.Label className="agent-panel-history-label">
                  Conversations about this note
                </DropdownMenu.Label>
                {agent.history.map((entry) => (
                  <DropdownMenu.Item
                    key={entry.id}
                    className="agent-panel-history-item"
                    data-current={entry.id === conversation.sessionId || undefined}
                    onSelect={() => void agent.openConversation(entry.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                    <span className="shrink-0 text-xs text-text-muted">
                      {formatDate(entry.updatedAt / 1000)}
                    </span>
                    <CheckIcon className="agent-panel-history-check w-3.5 h-3.5" />
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <Tooltip content="New conversation">
            <IconButton
              tabIndex={0}
              aria-label="New conversation"
              disabled={running || !currentNote}
              onClick={agent.newConversation}
            >
              <PlusIcon className="w-4 h-4" />
            </IconButton>
          </Tooltip>
          <IconButton
            tabIndex={0}
            title="Close agent panel"
            aria-label="Close agent panel"
            onClick={agent.close}
          >
            <XIcon className="w-4 h-4" />
          </IconButton>
        </header>
        <div className="agent-panel-context">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            Working in
          </span>
          <span className="truncate text-xs font-medium" title={contextTitle}>
            {contextTitle || "No note selected"}
          </span>
          <div className="mt-2 flex items-center justify-between gap-2 text-xs">
            <span role="status" aria-live="polite" className="text-text-muted">
              {presence.label}
            </span>
            <button
              type="button"
              className="agent-panel-link"
              disabled={!running && !agent.coediting && !!reason}
              onClick={() => {
                if (agent.coediting || running) void agent.stop();
                else void agent.startCompanion();
              }}
            >
              {agent.coediting || running ? "Pause" : "Write with me"}
            </button>
          </div>
          <McpServices onManage={onManageServers} />
        </div>
        <OpenNoteContext.Provider value={openNote}>
          <TraceLookupContext.Provider value={traceLookup}>
          <TraceReopenContext.Provider value={agent.reopenTrace}>
          <WritingOfferContext.Provider value={offerControls}>
          <div
            ref={scroll}
            className="agent-panel-messages"
            role="log"
            aria-label="Conversation"
            aria-busy={running}
          >
            <WorkingMemory />
            {!conversation.items.length && !offer && !suggestion && (
              <div className="agent-panel-empty">
                <h2 className="text-sm font-medium">A second pair of eyes.</h2>
                <p className="text-xs leading-relaxed text-text-muted">
                  Ask a question, refine a passage, or work through an idea.
                  Edits land directly, and the agent follows your changes as you write.
                </p>
              </div>
            )}
            {turns.map((turn, turnIndex) => (
              <SuggestionContext.Provider key={turn.id} value={turnIndex === turns.length - 1 ? sendSuggestion : null}>
                {turn.items.map((item, index) => (
                  // A wrapper that takes no box, so a map step can find the message it came from.
                  <div key={item.id} data-transcript-item={item.id} className="contents">
                  <AgentMessage
                    item={item}
                    active={running && turnIndex === turns.length - 1}
                    streaming={
                      running &&
                      turnIndex === turns.length - 1 &&
                      index === turn.items.length - 1 &&
                      item.type === "text"
                    }
                    pendingQuestionId={pendingQuestion?.id ?? null}
                    onAnswer={answer}
                    onDismissOffer={agent.dismissSkillOffer}
                  />
                  </div>
                ))}
                <AgentTurnChanges changes={turn.changes} turn={turnIndex + 1} />
              </SuggestionContext.Provider>
            ))}
          {visible && offerControls && !offerInTranscript && <WritingOfferCard {...offerControls} />}
          {!offer && suggestion && (
            <section className="agent-panel-observation" aria-label="Suggestion for your writing">
              <p>{suggestion.applied ? `I changed this: ${suggestion.text}` : suggestion.text}</p>
              <div>
                {suggestion.applied && <button type="button" onClick={agent.undoAppliedSuggestion}>Undo</button>}
                {agent.editor && agent.writingTarget && (
                  <button type="button" onClick={() => {
                    // Settle the viewport before the cursor starts its gesture.
                    scrollPositionIntoView(agent.editor!, agent.writingTarget!.from + 1, "instant");
                    setPointerReplay((value) => value + 1);
                  }}>Show passage</button>
                )}
                {!suggestion.applied && <button type="button" disabled={!sendSuggestion} onClick={() => {
                  // Goes straight to the agent; the draft in the composer is left alone.
                  sendSuggestion?.(`Let's explore this suggestion: ${suggestion.text}\n\nOffer ideas or wording without editing the note.`);
                  agent.dismissWritingSuggestion();
                }}>Explore this</button>}
                <button type="button" onClick={agent.dismissWritingSuggestion}>{suggestion.applied ? "Keep" : "Dismiss suggestion"}</button>
              </div>
            </section>
          )}
          {workingPhase && (
            <AgentWorking
              state={agent.companionChecking ? "reading" : stalled ? "thinking" : presence.state}
              expression={presence.expression}
              label={asked && (sending || agent.companionRequested) ? asked
                : stalled && !agent.companionChecking ? "Thinking" : presence.label}
              since={workStart}
              leaving={workingPhase === "leaving"}
              target={workRange ? { name: workTarget?.section ?? "your highlight", onShow: showWorkTarget } : null}
            />
          )}
          {conversation.cancelled && (
            <p className="text-xs text-text-muted">
              Paused. Edits already made are saved; use Undo in the note to undo an editor change.
            </p>
          )}
          {conversation.computerUnavailable && (
            <section role="status" className="agent-panel-error">
              <h3 className="text-sm font-medium">Computer access unavailable</h3>
              <p className="text-xs text-text-muted leading-relaxed">
                Chat and note editing are still available. {conversation.computerUnavailable.message}
              </p>
              <ComputerPermissions permissions={conversation.computerUnavailable.permissions} />
            </section>
          )}
          {conversation.error && (
            <section role="alert" className="agent-panel-error">
              <div className="flex items-center gap-2 text-xs font-medium">
                {usingAntigravity ? (
                  <>
                    <AntigravityIcon className="w-4 h-4 text-[#4f7cff] dark:text-[#7aa2ff]" />
                    Antigravity
                  </>
                ) : (
                  <>
                    <ChatGPTIcon className="w-4 h-4" />
                    ChatGPT
                  </>
                )}
              </div>
              <h3 className="text-sm font-medium">
                {
                  {
                    auth: "Sign in again to continue",
                    usage_limit: "Usage limit reached",
                    not_eligible: "ChatGPT plan not eligible",
                    writing_review: "Writing check interrupted",
                    other: "Something went wrong",
                  }[conversation.error.kind]
                }
              </h3>
              <p className="text-xs text-text-muted leading-relaxed">
                {conversation.error.message}
              </p>
              {conversation.error.kind === "writing_review" ? (
                <button type="button" className="agent-panel-link" disabled={!!reason || running || agent.companionChecking} onClick={() => void agent.startCompanion()}>
                  Retry writing check
                </button>
              ) : conversation.error.kind === "usage_limit" ? (
                <ManageUsage primary />
              ) : conversation.error.kind === "auth" ? (
                usingAntigravity ? (
                  <AntigravitySignIn />
                ) : (
                  <ContinueWithChatGPT />
                )
              ) : conversation.error.kind === "not_eligible" ? (
                <button type="button" className="agent-panel-link" onClick={() => { void agent.refreshStatus(); }}>
                  Check account again
                </button>
              ) : (
                <p className="text-xs text-text-muted">Send another message to try again.</p>
              )}
            </section>
          )}
          <PlanNotice />
          </div>
          </WritingOfferContext.Provider>
          </TraceReopenContext.Provider>
          </TraceLookupContext.Provider>
        </OpenNoteContext.Provider>
        {changes.length > 0 && (
          <div className="agent-panel-review" aria-label="Review external changes">
            <span className="mr-auto font-medium">
              {changes.length} external {changes.length === 1 ? "change" : "changes"}
            </span>
            <IconButton
              tabIndex={0}
              title="Previous change"
              aria-label="Previous change"
              onClick={() => navigate(-1)}
            >
              <ArrowUpIcon className="w-3.5 h-3.5" />
            </IconButton>
            <IconButton
              tabIndex={0}
              title="Next change"
              aria-label="Next change"
              onClick={() => navigate(1)}
            >
              <ArrowDownIcon className="w-3.5 h-3.5" />
            </IconButton>
            <button
              type="button"
              className="agent-panel-link"
              onClick={() => agent.editor?.commands.rejectAllAgentChanges()}
            >
              Reject all
            </button>
            <button
              type="button"
              className="agent-panel-primary"
              onClick={() => agent.editor?.commands.acceptAllAgentChanges()}
            >
              Accept all
            </button>
          </div>
        )}
        <div className="agent-panel-composer">
          {showChatGptSignIn && (
            <div className="mb-3 space-y-2">
              <p className="text-xs text-text-muted leading-relaxed">
                Sign in with ChatGPT to use Codex in ChatGSD. Your plan's Codex usage limits apply.
              </p>
              <ContinueWithChatGPT />
            </div>
          )}
          {reason && !showChatGptSignIn && (
            <p
              className="mb-2 flex items-center gap-2 text-xs text-text-muted"
              role="status"
            >
              {(agent.statusLoading || agent.modelsLoading) && (
                <SpinnerIcon className="w-3.5 h-3.5 animate-spin shrink-0" />
              )}
              {reason}
            </p>
          )}
          {((!anyReady &&
            (agent.statusError ||
              status?.status === "error" ||
              (!status && !agent.statusLoading))) ||
            agent.modelsError) && (
            <button
              type="button"
              className="agent-panel-link mb-2"
              onClick={() => {
                // Signed in but the model list failed: retry that request,
                // since a status refresh leaves readiness unchanged.
                if (anyReady && agent.modelsError)
                  agent.reloadModels();
                else {
                  void agent.refreshStatus();
                  if (agent.antigravityEnabled) void agent.refreshAntigravityStatus?.();
                }
              }}
            >
              Try again
            </button>
          )}
          {/* A highlight brings its own actions, so the general starters step aside. */}
          {!waiting && !draft && !offer && !reason && !selectionSummary && (
            <div className="agent-panel-starters" aria-label="Ways to work together">
              {/* Once the agent has read the note, its own next moves replace the standing suggestions. */}
              {agent.writingStarters.length > 0 ? agent.writingStarters.map((starter) => (
                <button type="button" key={starter} disabled={sending || (running && !agent.companionChecking)}
                  onClick={() => { void deliver(starter, () => {}); }}>{starter}</button>
              )) : starters.map(({ label, kind, fitting }) => (
                <button type="button" key={label} data-fitting={fitting || undefined} disabled={sending || (running && !agent.companionChecking)}
                  onClick={() => { void agent.requestWritingHelp(kind); }}>{label}</button>
              ))}
            </div>
          )}
          <div ref={composerBox} className="agent-panel-input-wrap" data-holding={selectionSummary ? "" : undefined}>
            {typedSkill !== null && (
              <SkillMenu
                anchor={composerBox.current}
                id={skillListId}
                skills={skillMatches}
                query={typedSkill}
                active={highlightedSkill}
                empty={skills?.some((skill) => skill.enabled)
                  ? `No skill matches /${typedSkill}`
                  : "No skills are on. Add or turn one on in Settings → Skills."}
                onHighlight={setSkillIndex}
                onPick={pickSkill}
              />
            )}
            {selectionSummary && (
              <SelectionCard
                summary={selectionSummary}
                running={running}
                onReveal={revealSelection}
                onClear={clearSelection}
                actions={selectionActions}
                busy={sending || agent.companionChecking}
                compact={!!draft.trim()}
              />
            )}
            <textarea
              ref={composer}
              rows={selectionSummary ? 2 : 3}
              aria-label="Message agent"
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-controls={skillMenuOpen ? skillListId : undefined}
              aria-activedescendant={skillMenuOpen && skillMatches.length
                ? skillOptionId(skillListId, highlightedSkill) : undefined}
              placeholder={
                pendingQuestion
                  ? "Type your answer…"
                  : steering
                    ? "Steer the agent…"
                    : selectionSummary
                      ? "Ask about this passage…"
                      : "Ask or describe an edit…"
              }
              value={draft}
              readOnly={!currentNote}
              onChange={(event) => {
                setDraft(event.target.value);
                setCaret(event.target.selectionStart);
                setSkillIndex(0);
                setSkillMenuClosed(false);
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
              onBlur={() => setSkillMenuClosed(true)}
              onKeyDown={(event) => {
                if (skillMenuOpen && !event.nativeEvent.isComposing) {
                  const count = skillMatches.length;
                  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) {
                    event.preventDefault();
                    setSkillIndex((highlightedSkill + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
                    return;
                  }
                  const name = count ? skillMatches[highlightedSkill].name : null;
                  // Enter on a name typed in full sends it; otherwise Tab and Enter complete it.
                  if (name && !event.shiftKey && (event.key === "Tab" || (event.key === "Enter" && name !== typedSkill))) {
                    event.preventDefault();
                    pickSkill(name);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setSkillMenuClosed(true);
                    return;
                  }
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  clearSelection();
                  agent.editor?.commands.focus();
                } else if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="flex items-center justify-between gap-2 px-2.5 pb-2">
              <span className="min-w-0 text-[10px] text-text-muted">
                {skillMenuOpen && skillMatches.length
                  ? "↑↓ to choose · Tab to complete · Esc to close"
                  : invoked
                  ? `Enter to run /${invoked} · ⇧ Enter for newline`
                  : pendingQuestion
                  ? "Enter to answer · ⇧ Enter for newline"
                  : steering
                    ? draft.trim()
                      ? "Enter to steer · ⇧ Enter for newline"
                      : "Type to steer, or keep editing."
                    : running
                      ? "You can keep editing."
                      : "Enter to send · ⇧ Enter for newline"}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                {running && !agent.companionChecking && (
                  <IconButton
                    tabIndex={0}
                    aria-label="Stop agent"
                    title="Stop the agent"
                    onClick={() => {
                      void agent.stop();
                    }}
                  >
                    <StopIcon className="w-4 h-4" />
                  </IconButton>
                )}
                {(!running || waiting || (steering && !!draft.trim())) && (
                  <IconButton
                    tabIndex={0}
                    aria-label={sendLabel}
                    title={sendLabel}
                    disabled={!!reason || sending || !draft.trim()}
                    onClick={() => {
                      void submit();
                    }}
                  >
                    <ArrowUpIcon className="w-4 h-4" />
                  </IconButton>
                )}
              </div>
            </div>
          </div>
          {usingAntigravity ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-1 text-[10px] text-text-muted">
              <span>Using Antigravity plan</span>
            </div>
          ) : status?.account?.planUsage && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1 text-[10px] text-text-muted">
              <span>Using ChatGPT plan</span>
              {agent.supportsPriority && agent.priorityMode && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Priority</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <ManageUsage />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
