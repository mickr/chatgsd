import {
  Fragment,
  useCallback,
  useEffect,
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
import { useNotes } from "../../context/NotesContext";
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
  AgentIcon,
  ChatGPTIcon,
  CheckIcon,
  HistoryIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  PlusIcon,
  SpinnerIcon,
  XIcon,
} from "../icons";
import { IconButton, Tooltip } from "../ui";
import { formatDate } from "../../lib/utils";
import { AgentMessage } from "./AgentMessage";
import { ContinueWithChatGPT, ManageUsage, PlanNotice } from "./ChatGPTAccount";
import { AgentTurnChanges, conversationTurns } from "./AgentTurnChanges";
import { OpenNoteContext } from "./ui/registry";
import { SelectionCard } from "./SelectionCard";
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
export function AgentPanel({ visible }: { visible: boolean }) {
  const agent = useAgent();
  const { currentNote, selectNote } = useNotes();
  const changes = useAgentChanges(agent.editor);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<SelectionSummary | null>(null);
  // The run's selection as it maps through edits, for its section and scrolling.
  const [focusRange, setFocusRange] = useState<{ from: number; to: number } | null>(null);
  const [reviewIndex, setReviewIndex] = useState(-1);
  const [sending, setSending] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const status = agent.status;
  const conversation = agent.conversation;
  const turns = useMemo(() => conversationTurns(conversation.items), [conversation.items]);
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
  const needsPlanNotice =
    status?.account?.planUsage && !status.account.planNoticeSeen;
  const showChatGptSignIn =
    status?.status === "signed_out" ||
    status?.status === "plan_usage_disabled";
  const reason = !currentNote
    ? "Open a note to start a conversation."
    : agent.statusLoading
      ? "Checking your ChatGPT account…"
      : !status
        ? (agent.statusError ?? "ChatGPT is unavailable. Try again.")
        : status.status !== "ready"
          ? (status.detail ??
            (status.status === "signed_out"
              ? "Sign in with ChatGPT to get started."
              : "ChatGPT plan usage is disabled. Continue with ChatGPT to enable it."))
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
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [conversation.items, conversation.error, running]);
  useEffect(() => {
    follow.current = true;
    setReviewIndex(-1);
  }, [currentNote?.id]);
  const { pendingQuestion, answerQuestion } = agent;
  const waiting = !!pendingQuestion;
  const sendLabel = pendingQuestion ? "Send answer" : "Send message";
  const answer = useCallback(
    (value: QuestionAnswer) => {
      follow.current = true;
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
      follow.current = true;
      await answerQuestion(text);
      return;
    }
    if (running) return;
    const text = draft;
    setSending(true);
    setDrafts((previous) => ({ ...previous, [id]: "" }));
    follow.current = true;
    try {
      if (!(await agent.send(text)))
        setDrafts((previous) => ({ ...previous, [id]: previous[id] || text }));
    } finally {
      setSending(false);
    }
  };
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
  return (
    <aside
      className={`agent-panel ${visible ? "agent-panel-open" : ""}`}
      style={{ width: visible ? agent.width : 0 }}
      aria-label="Agent"
      aria-hidden={!visible}
      inert={!visible}
    >
      {visible && <ResizeHandle />}
      <div className="agent-panel-inner" style={{ width: agent.width }}>
        <header className="agent-panel-header">
          <AgentIcon className="w-4 h-4 shrink-0 text-text-muted" />
          <div className="min-w-0 flex-1">
            {/* pl-2 matches the inset WebKit gives the native model <select> text below. */}
            <h2 className="text-sm font-medium pl-2 py-0.5">ChatGPT</h2>
            {status?.status === "ready" && (
              <select
                aria-label="Agent model"
                value={agent.model}
                onChange={(event) => agent.setModel(event.target.value)}
                disabled={running || agent.modelsLoading}
                className="agent-panel-select text-xs text-text-muted"
              >
                {agent.models.length ? (
                  agent.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))
                ) : (
                  <option value="">
                    {agent.modelsLoading ? "Loading models…" : "Default model"}
                  </option>
                )}
              </select>
            )}
          </div>
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
          {selectionSummary && (
            <SelectionCard
              summary={selectionSummary}
              running={running}
              onReveal={revealSelection}
              onClear={clearSelection}
            />
          )}
          <div className="mt-2 flex items-center justify-between gap-2 text-xs">
            <span role="status" className="text-text-muted">
              {agent.coediting
                ? running ? "Coediting · Working" : "Coediting · Following your edits"
                : running ? "Finishing current turn" : "Coediting paused"}
            </span>
            <button
              type="button"
              className="agent-panel-link"
              disabled={!running && !agent.coediting && !!reason}
              onClick={() => {
                if (agent.coediting || running) void agent.stop();
                else agent.resumeCoediting();
              }}
            >
              {agent.coediting || running ? "Pause" : "Start coediting"}
            </button>
          </div>
        </div>
        <OpenNoteContext.Provider value={openNote}>
          <div
            ref={scroll}
            className="agent-panel-messages"
            role="log"
            aria-label="Conversation"
            aria-busy={running}
            onScroll={() => {
              const element = scroll.current;
              if (element)
                follow.current =
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  60;
            }}
          >
            {!conversation.items.length && (
              <div className="agent-panel-empty">
                <AgentIcon className="w-7 h-7 text-text-muted/50" />
                <h2 className="text-sm font-medium">A second pair of eyes.</h2>
                <p className="text-xs leading-relaxed text-text-muted">
                  Ask a question, refine a passage, or work through an idea.
                  Edits land directly. The agent follows your changes while coediting is active.
                </p>
              </div>
            )}
            {turns.map((turn, turnIndex) => (
              <Fragment key={turn.id}>
                {turn.items.map((item, index) => (
                  <AgentMessage
                    key={item.id}
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
                ))}
                <AgentTurnChanges changes={turn.changes} turn={turnIndex + 1} />
              </Fragment>
            ))}
          {running &&
            !waiting &&
            conversation.items[conversation.items.length - 1]?.type !==
              "text" && (
              <div className="flex gap-2 items-center text-xs text-text-muted">
                <SpinnerIcon className="w-3.5 h-3.5 animate-spin" />
                Working…
              </div>
            )}
          {conversation.cancelled && (
            <p className="text-xs text-text-muted">
              Paused. Edits already made are saved; use Undo in the note to undo an editor change.
            </p>
          )}
          {conversation.error && (
            <section role="alert" className="agent-panel-error">
              <div className="flex items-center gap-2 text-xs font-medium">
                <ChatGPTIcon className="w-4 h-4" />
                ChatGPT
              </div>
              <h3 className="text-sm font-medium">
                {
                  {
                    auth: "Sign in again to continue",
                    usage_limit: "Usage limit reached",
                    not_eligible: "ChatGPT plan not eligible",
                    other: "Something went wrong",
                  }[conversation.error.kind]
                }
              </h3>
              <p className="text-xs text-text-muted leading-relaxed">
                {conversation.error.message}
              </p>
              {conversation.error.kind === "usage_limit" ? (
                <ManageUsage primary />
              ) : conversation.error.kind === "auth" ? (
                <ContinueWithChatGPT />
              ) : (
                <button
                  type="button"
                  className="agent-panel-link"
                  onClick={() => {
                    void agent.refreshStatus();
                  }}
                >
                  Check account again
                </button>
              )}
            </section>
          )}
          <PlanNotice />
          </div>
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
                {status?.status === "plan_usage_disabled"
                  ? "You're signed in, but ChatGSD can't use your ChatGPT plan yet. Continue with ChatGPT to allow it."
                  : "Use your ChatGPT plan in ChatGSD. Eligible requests use your plan or credits balance."}
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
          {(agent.statusError ||
            agent.modelsError ||
            (!status && !agent.statusLoading)) && (
            <button
              type="button"
              className="agent-panel-link mb-2"
              onClick={() => {
                // Signed in but the model list failed: retry that request,
                // since a status refresh leaves readiness unchanged.
                if (status?.status === "ready" && agent.modelsError)
                  agent.reloadModels();
                else void agent.refreshStatus();
              }}
            >
              Try again
            </button>
          )}
          <div className="agent-panel-input-wrap">
            <textarea
              ref={composer}
              rows={3}
              aria-label="Message agent"
              placeholder={
                pendingQuestion
                  ? "Type your answer…"
                  : "Ask or describe an edit…"
              }
              value={draft}
              readOnly={!currentNote}
              onChange={(event) => {
                if (currentNote)
                  setDrafts((previous) => ({
                    ...previous,
                    [currentNote.id]: event.target.value,
                  }));
              }}
              onKeyDown={(event) => {
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
              <span className="text-[10px] text-text-muted">
                {pendingQuestion
                  ? "Enter to answer · ⇧ Enter for newline"
                  : running
                    ? "You can keep editing."
                    : "Enter to send · ⇧ Enter for newline"}
              </span>
              <div className="flex items-center gap-1.5">
                {(!running || waiting) && (
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
          {status?.account?.planUsage && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1 text-[10px] text-text-muted">
              <span>Using ChatGPT plan</span>
              <span aria-hidden="true">·</span>
              <ManageUsage />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
