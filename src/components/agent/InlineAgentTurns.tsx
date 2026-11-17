import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useAgent, type QuestionAnswer } from "../../context/AgentContext";
import { useNotes } from "../../context/NotesContext";
import { AgentMessage } from "./AgentMessage";
import { AgentTurnChanges, conversationTurns } from "./AgentTurnChanges";
import { OpenNoteContext } from "./ui/registry";
import { displayInstruction } from "./InlineAgentActivity";

export function InlineAgentTurns({ onAnswer }: { onAnswer: (answer: QuestionAnswer) => void }) {
  const agent = useAgent();
  const { selectNote } = useNotes();
  const { conversation, pendingQuestion } = agent;
  const turns = useMemo(() => conversationTurns(conversation.items).map((turn) => ({
    ...turn,
    items: turn.items.map((item) => item.type === "user" ? { ...item, text: displayInstruction(item.text) } : item),
  })), [conversation.items]);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const running = conversation.runId !== null;
  const openNote = useCallback((id: string) => { void selectNote(id); }, [selectNote]);
  useLayoutEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [conversation.items]);

  return <OpenNoteContext.Provider value={openNote}>
    <div ref={scroll} className="inline-agent-turns" role="log" aria-label="Inline conversation turns" aria-live="off" aria-busy={running}
      onScroll={(event) => {
        const element = event.currentTarget;
        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
      }}>
      {!turns.length && <p className="inline-agent-empty">Your request will appear here with the agent’s reply.</p>}
      {turns.map((turn, turnIndex) => <section key={turn.id} className="inline-agent-turn" aria-label={`Turn ${turnIndex + 1}`}>
        <h3 className="inline-agent-turn-label">Turn {turnIndex + 1}</h3>
        {turn.items.map((item, index) => <AgentMessage key={item.id} item={item}
          active={running && turnIndex === turns.length - 1}
          streaming={running && turnIndex === turns.length - 1 && index === turn.items.length - 1 && item.type === "text"}
          pendingQuestionId={pendingQuestion?.id ?? null} onAnswer={onAnswer} onDismissOffer={agent.dismissSkillOffer} />)}
        <AgentTurnChanges changes={turn.changes} turn={turnIndex + 1} />
      </section>)}
    </div>
  </OpenNoteContext.Provider>;
}
