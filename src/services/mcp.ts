import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Whether the agent may call a tool: freely, after asking, or never. */
export type McpToolPolicy = "allow" | "ask" | "off";
export type McpConnection =
  | "disconnected"
  | "connecting"
  | "connected"
  | "needs_auth"
  | "authorizing"
  | "error";
export interface McpTool {
  name: string;
  title: string | null;
  description: string;
  /** The server's own claim that the tool changes nothing. */
  readOnly: boolean;
  policy: McpToolPolicy;
}
/** An MCP server the user added. Tokens stay in the backend. */
export interface McpServer {
  id: string;
  name: string;
  /** What the agent calls the server. */
  key: string;
  url: string;
  enabled: boolean;
  /** On this Mac or its network. */
  local: boolean;
  clientId: string | null;
  /** How ChatGSD signs in: OAuth, a token the user pasted, or not at all. */
  auth: "oauth" | "token" | "none";
  status: McpConnection;
  detail: string | null;
  tools: McpTool[];
}
export interface McpServerInput {
  url: string;
  /** Left out, the server's own name is used. */
  name?: string;
  /** When updating: left out keeps the saved token, empty removes it. */
  token?: string;
  clientId?: string;
}

export const listServers = () => invoke<McpServer[]>("mcp_list_servers");
/** The loopback address to register for a hand-made OAuth client. */
export const redirectUri = () => invoke<string>("mcp_redirect_uri");
/** Saves the server and connects, reading its name and tools from it. */
export const addServer = (request: McpServerInput) =>
  invoke<McpServer>("mcp_add_server", { request });
export const updateServer = (id: string, request: McpServerInput) =>
  invoke<McpServer>("mcp_update_server", { id, request });
export const removeServer = (id: string) =>
  invoke<void>("mcp_remove_server", { id });
export const setServerEnabled = (id: string, enabled: boolean) =>
  invoke<void>("mcp_set_server_enabled", { id, enabled });
/** Starts a fresh session and re-reads the server's tools. */
export const connectServer = (id: string) =>
  invoke<void>("mcp_connect_server", { id });
/** Opens the server's sign-in in the browser; resolves when it finishes or is cancelled. */
export const authorizeServer = (id: string) =>
  invoke<void>("mcp_authorize_server", { id });
export const cancelAuthorize = (id: string) =>
  invoke<void>("mcp_cancel_authorize", { id });
export const signOutServer = (id: string) =>
  invoke<void>("mcp_sign_out_server", { id });
export const setToolPolicy = (id: string, tool: string, policy: McpToolPolicy) =>
  invoke<void>("mcp_set_tool_policy", { id, tool, policy });
export const onServersChanged = (handler: (servers: McpServer[]) => void) =>
  listen<McpServer[]>("mcp:changed", ({ payload }) => handler(payload));

export const CONNECTION_LABELS: Record<McpConnection, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  needs_auth: "Sign-in needed",
  authorizing: "Waiting for sign-in…",
  error: "Can't connect",
  disconnected: "Not connected",
};
/** A server's state in a word or two; a server that's off says so. */
export const connectionLabel = (server: McpServer) =>
  server.enabled ? CONNECTION_LABELS[server.status] : "Off";
