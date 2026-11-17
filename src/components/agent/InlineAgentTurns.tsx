import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useAgent, type QuestionAnswer } from "../../context/AgentContext";
import { useNotes } from "../../context/NotesContext";
import { AgentMessage } from "./AgentMessage";
import { AgentTurnChanges, conversationTurns } from "./AgentTurnChanges";
import { OpenNoteContext } from "./ui/registry";
import { displayInstruction } from "./InlineAgentActivity";

export function InlineAgentTurns({ onAnswer, children }: { onAnswer: (answer: QuestionAnswer) => void; children?: ReactNode }) {
  const agent = useAgent();
  const { selectNote } = useNotes();
  const { conversation, pendingQuestion } = agent;
  const turns = useMemo(() => conversationTurns(conversation.items).map((turn) => ({
    ...turn,
    items: turn.items.map((item) => item.type === "user" ? { ...item, text: displayInstruction(item.text) } : item),
  })), [conversation.items]);
  const scroll = useRef<HTMLDivElement>(null);
  const running = conversation.runId !== null;
  const openNote = useCallback((id: string) => { void selectNote(id); }, [selectNote]);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [conversation.items, conversation.error, running, agent.writingSuggestion, agent.writingOffer?.id]);

  return <OpenNoteContext.Provider value={openNote}>
    <div ref={scroll} className="inline-agent-turns" role="log" aria-label="Inline conversation turns" aria-live="off" aria-busy={running}>
      {!turns.length && !agent.writingSuggestion && <p className="inline-agent-empty">A second pair of eyes while you write. We can work through a rough sentence, check an argument, or find your next idea.</p>}
      {turns.map((turn, turnIndex) => <section key={turn.id} className="inline-agent-turn" aria-label={`Turn ${turnIndex + 1}`}>
        {turn.items.map((item, index) => <AgentMessage key={item.id} item={item}
          active={running && turnIndex === turns.length - 1}
          streaming={running && turnIndex === turns.length - 1 && index === turn.items.length - 1 && item.type === "text"}
          pendingQuestionId={pendingQuestion?.id ?? null} onAnswer={onAnswer} onDismissOffer={agent.dismissSkillOffer} />)}
        <AgentTurnChanges changes={turn.changes} turn={turnIndex + 1} />
      </section>)}
      {children}
    </div>
  </OpenNoteContext.Provider>;
}
