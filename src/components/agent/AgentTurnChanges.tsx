import { useState } from "react";
import { ChangeDiff } from "./ChangeDiff";
import type { TranscriptItem } from "../../context/AgentContext";
import type { NoteChange } from "../../lib/agent/turnChanges";

export function conversationTurns(items: TranscriptItem[]) {
  const turns: Array<{ id: string; items: TranscriptItem[]; changes: NoteChange[] }> = [];
  for (const item of items) {
    if (!turns.length || item.type === "user" || item.type === "activity")
      turns.push({ id: item.id, items: [], changes: [] });
    const turn = turns[turns.length - 1];
    if (item.type === "changes") turn.changes.push(item.change);
    else turn.items.push(item);
  }
  return turns;
}

export function AgentTurnChanges({ changes, turn }: { changes: NoteChange[]; turn: number }) {
  const [expanded, setExpanded] = useState(false);
  if (!changes.length) return null;
  const count = changes.reduce((total, change) => total + change.hunks.length, 0);
  return (
    <details className="agent-turn-changes" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span>Changes this turn</span>
        <span className="agent-turn-change-count">{count} {count === 1 ? "change" : "changes"}</span>
      </summary>
      <div className="agent-turn-change-caption">Turn {turn} · Recorded at edit time</div>
      {changes.map((change, index) => (
        <section key={index} aria-label={`Change ${index + 1} in ${change.noteTitle}`}>
          <h3>{change.noteTitle}</h3>
          {change.hunks.map((hunk, hunkIndex) => (
            <div className="agent-turn-hunk" key={hunkIndex}>
              {hunk.line !== undefined && <div className="agent-turn-line">Line {hunk.line}</div>}
              {expanded && <ChangeDiff
                name={change.noteTitle}
                before={hunk.before.length ? `${hunk.before.join("\n")}\n` : ""}
                after={hunk.after.length ? `${hunk.after.join("\n")}\n` : ""}
              />}
            </div>
          ))}
        </section>
      ))}
    </details>
  );
}
