import { useAgent } from "../../context/AgentContext";
import { alt, mod, shortcut } from "../../lib/platform";
import { agentPresence } from "./InlineAgentActivity";
import { InlineAgentFace } from "./InlineAgentFace";
import "./AgentLauncher.css";

/** The agent's face while its panel is hidden: what it is doing, and the way back in. */
export function AgentLauncher({ onOpen }: { onOpen: () => void }) {
  const agent = useAgent();
  const presence = agentPresence(agent);
  const active = agent.coediting || agent.conversation.runId !== null;
  return (
    <div className="agent-launcher-dock">
      <button type="button" className="agent-launcher" aria-label="Open agent"
        title={`Open agent (${shortcut(mod, alt, "Enter")})`} onClick={onOpen}>
        <InlineAgentFace state={presence.state} expression={presence.expression} />
        <span>
          <span>{presence.feedback?.label ?? (agent.writingSuggestion ? "An idea for your writing" : "Writing companion")}</span>
          <span>{active ? presence.label : shortcut(mod, alt, "Enter")}</span>
        </span>
      </button>
    </div>
  );
}
