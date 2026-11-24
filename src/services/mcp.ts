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
  /** The command a server on this Mac runs as, without its variables. */
  command: string | null;
  /** `stdio` for a program on this Mac that ChatGSD starts, `http` for a server at an address. */
  transport: "http" | "stdio";
  enabled: boolean;
  /** On this Mac or its network. */
  local: boolean;
  clientId: string | null;
  /** The loopback port that client was registered with, when it isn't ChatGSD's own. */
  callbackPort: number | null;
  /** A secret is saved for that client. The secret itself stays in the backend. */
  clientSecret: boolean;
  /** Sign-in is waiting on an OAuth client the user has to create at the service. */
  needsClient: boolean;
  /** How ChatGSD signs in: OAuth, a token the user pasted, or not at all. */
  auth: "oauth" | "token" | "none";
  status: McpConnection;
  detail: string | null;
  /** What the user told the agent about using this server and showing what it returns. */
  hint: string | null;
  tools: McpTool[];
}
export interface McpServerInput {
  url: string;
  /** Left out, the server's own name is used. */
  name?: string;
  /** When updating: left out keeps the saved token, empty removes it. */
  token?: string;
  clientId?: string;
  /** When updating: left out keeps the saved secret, empty removes it. */
  clientSecret?: string;
  /** The port that client's redirect address was registered with. Left out, ChatGSD's own is used. */
  callbackPort?: number;
}
/** A server that runs on this Mac, as typed in settings and saved to `mcp.json`. */
export interface McpLocalServerInput {
  name: string;
  /** The command line that starts it. */
  command: string;
  /** `NAME=value` lines. */
  env?: string;
}
/** A server another app on this Mac is set up with that ChatGSD doesn't have. */
export interface McpFoundServer {
  id: string;
  name: string;
  /** The command it runs, or its address. */
  detail: string;
  /** The apps it is set up in, such as Codex or Cursor. */
  places: string[];
}
export interface McpConfig {
  /** What is wrong with `mcp.json`, in words for the user. */
  problem: string | null;
  found: McpFoundServer[];
}

export const listServers = () => invoke<McpServer[]>("mcp_list_servers");
/** The loopback address to register for a hand-made OAuth client. */
export const redirectUri = () => invoke<string>("mcp_redirect_uri");
/** Saves the server and connects, reading its name and tools from it. */
export const addServer = (request: McpServerInput) =>
  invoke<McpServer>("mcp_add_server", { request });
/** Writes the server into `mcp.json` and starts it. */
export const addLocalServer = (request: McpLocalServerInput) =>
  invoke<McpServer>("mcp_add_local_server", { request });
/** Follows `mcp.json` as it is now, and lists what other apps have that could be added. */
export const loadConfig = () => invoke<McpConfig>("mcp_load_config");
export const addFoundServer = (id: string) =>
  invoke<McpServer>("mcp_add_found_server", { id });
/** Shows `mcp.json` in Finder, creating it if there is none yet. */
export const revealConfig = () => invoke<void>("mcp_reveal_config");
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
/** Saves the user's hint to the agent about a server; empty removes it. */
export const setServerHint = (id: string, hint: string) =>
  invoke<void>("mcp_set_server_hint", { id, hint });
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
