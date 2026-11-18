import { connectionLabel, type McpServer } from "../../services/mcp";

const STATUS_DOTS: Record<McpServer["status"], string> = {
  connected: "bg-accent",
  connecting: "bg-text-muted animate-pulse",
  authorizing: "bg-amber-500 animate-pulse",
  needs_auth: "bg-amber-500",
  error: "bg-red-500",
  disconnected: "bg-text-muted/50",
};

/** A server's connection state as a dot and a word or two. */
export function McpServerStatus({ server }: { server: McpServer }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-muted" role="status">
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${server.enabled ? STATUS_DOTS[server.status] : STATUS_DOTS.disconnected}`}
      />
      {connectionLabel(server)}
    </span>
  );
}
