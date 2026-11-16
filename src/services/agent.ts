import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ChatGptAccount {
  email: string;
  planUsage: boolean;
  planNoticeSeen: boolean;
}
export interface AgentStatus {
  status: "ready" | "signed_out" | "plan_usage_disabled";
  detail: string | null;
  account: ChatGptAccount | null;
}
export interface ModelInfo {
  id: string;
  label: string;
}
export interface RunContext {
  noteId: string;
  noteTitle: string;
  selection: string | null;
}
export interface StartRunRequest {
  model: string | null;
  sessionId: string | null;
  prompt: string;
  context: RunContext;
}
export type AgentErrorKind = "auth" | "usage_limit" | "not_eligible" | "other";
export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; ok: boolean; output: string }
  | { type: "done"; stopReason: "completed" | "cancelled" }
  | { type: "error"; kind: AgentErrorKind; message: string };
export interface AgentEventPayload {
  runId: string;
  event: AgentEvent;
}
export interface ToolRequest {
  requestId: string;
  runId: string;
  name: string;
  args: unknown;
}

export const getStatus = () => invoke<AgentStatus>("agent_status");
export const listModels = () => invoke<ModelInfo[]>("agent_list_models");
export const startRun = (request: StartRunRequest) =>
  invoke<{ runId: string }>("agent_start_run", { request });
export const cancelRun = (runId: string) =>
  invoke<void>("agent_cancel_run", { runId });
export const toolRespond = (requestId: string, ok: boolean, output: string) =>
  invoke<void>("agent_tool_respond", { requestId, ok, output });
export const signIn = () => invoke<ChatGptAccount>("chatgpt_sign_in");
export const cancelSignIn = () => invoke<void>("chatgpt_cancel_sign_in");
export const signOut = () => invoke<void>("chatgpt_sign_out");
export const ackPlanNotice = () => invoke<void>("chatgpt_ack_plan_notice");
export const onAgentEvent = (handler: (payload: AgentEventPayload) => void) =>
  listen<AgentEventPayload>("agent:event", ({ payload }) => handler(payload));
export const onToolRequest = (handler: (payload: ToolRequest) => void) =>
  listen<ToolRequest>("agent:tool-request", ({ payload }) => handler(payload));
export const openUsage = () =>
  invoke<void>("open_url_safe", { url: "https://chatgpt.com/settings/usage" });
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
