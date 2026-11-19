import { useAgent } from "../../context/AgentContext";

export function WorkingMemory() {
  const agent = useAgent();
  const entries = agent.memory?.entries;
  if (!entries?.length) return null;
  const current = entries.find(item => item.kind === "assignment" && item.status === "open")
    ?? entries.find(item => item.status !== "done");
  const busy = !!agent.conversation.runId || agent.companionChecking;
  return <details className="agent-working-memory">
    <summary>{current ? current.summary : "Completed work"} <span>· {entries.length} saved</span></summary>
    <ul>{entries.map(item => <li key={item.key}>
      <small>{item.status === "done" ? (item.kind === "thought" ? "Returned to you" : "Completed")
        : item.kind === "insight" ? "Agent’s insight"
        : item.kind === "choice" && item.key.startsWith("meaning-") ? "What you meant"
        : item.kind === "choice" ? "Writer’s choice"
        : item.kind === "thought" ? "Held thought" : item.status === "waiting" ? "Waiting" : "Assignment"}</small>
      <p>{item.summary}</p>
      {item.quote && <blockquote>{item.quote}</blockquote>}
      {item.next && <p>{item.next}</p>}
      <div>
        {item.kind !== "choice" && item.kind !== "insight" && item.status !== "done" && <button type="button" className="agent-panel-link"
          disabled={busy} onClick={() => void agent.send(`Revisit the saved item with key ${item.key} in this note’s working memory. Check the current note and bring me the next result or decision. Preview any proposed changes.`)}>Revisit</button>}
        <button type="button" className="agent-panel-link" disabled={busy}
          aria-label={`Forget ${item.summary}`} onClick={() => void agent.forgetMemory(item.key)}>Forget</button>
      </div>
    </li>)}</ul>
  </details>;
}
