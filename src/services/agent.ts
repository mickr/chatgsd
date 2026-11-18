import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ChatGptAccount {
  email: string;
  planUsage: boolean;
  planNoticeSeen: boolean;
}
export interface AgentStatus {
  status: "ready" | "signed_out" | "error";
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
  computerAccess?: boolean;
  webAccess?: boolean;
}
export interface StartRunRequest {
  /** Background writing check-ins can read the note but cannot edit or use other apps. */
  readOnly?: boolean;
  model: string | null;
  /** Scratch UI block guide, generated from the json-render catalog. */
  uiGuide: string;
  sessionId: string | null;
  prompt: string;
  computerAccess: boolean;
  /** Internet access: the research role and skill offers. */
  webAccess: boolean;
  /** Model for the research role; null runs it on `model`. */
  researchModel: string | null;
  /** The user's brief for the research role; null uses the built-in one. */
  researchBrief: string | null;
  context: RunContext;
}
export type AgentErrorKind = "auth" | "usage_limit" | "not_eligible" | "other";
/** Model-authored UI metadata, independent of the run's activity or completion. */
export interface AgentExpression {
  expression: "neutral" | "curious" | "focused" | "uncertain" | "pleased" | "concerned";
  sentiment: number;
  intensity: number;
}
export type ComputerPermission = "accessibility" | "screen_recording";
export interface ComputerUnavailable { message: string; permissions: ComputerPermission[] }
export type AgentEvent =
  | ({ type: "computer_unavailable" } & ComputerUnavailable)
  | { type: "session"; sessionId: string }
  | { type: "text_delta"; text: string }
  | ({ type: "expression" } & AgentExpression)
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; ok: boolean; output: string }
  | ({ type: "skill_offer" } & SkillOffer)
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
/** An installed skill: a SKILL.md the user saved for the agent. */
export interface Skill {
  name: string;
  description: string;
  /** The address it was saved from, when it came from the web. */
  source: string | null;
  /** Unix milliseconds; 0 when unknown. */
  installedAt: number;
  enabled: boolean;
  content: string;
  /** Paths of the files saved beside SKILL.md. */
  files: string[];
  /** `sha256:<hex>` of the download it was saved from; null when added by hand. */
  digest: string | null;
}
/** A skill found on the web, not yet saved. */
export interface SkillOffer {
  name: string;
  description: string;
  source: string;
  content: string;
  /** Paths of the text files an archived skill brings along. */
  files: string[];
  /** `sha256:<hex>` of the download the offer was read from. */
  digest: string;
  archive: boolean;
}
export interface ConversationSummary {
  id: string;
  documentId: string;
  title: string;
  /** Unix milliseconds. */
  createdAt: number;
  updatedAt: number;
}

export type InlineIntent = "discuss" | "suggest" | "edit" | "research" | "clarify";
export type ModelRoute = "fast" | "deep";
export interface InlineDecision { intent: InlineIntent; confidence: number; route: ModelRoute }
export interface InlineContext {
  title: string;
  selection: string;
  before: string;
  after: string;
  message: string;
  history: Array<{ role: string; text: string }>;
}
export const classifyInlineContext = (context: InlineContext) =>
  invoke<InlineDecision>("agent_classify_inline", { context });

export interface MemoryEntry {
  key: string;
  kind: "assignment" | "thought" | "choice";
  status: "open" | "waiting" | "done";
  summary: string;
  quote: string | null;
  next: string | null;
}
export interface NoteMemory { documentId: string; revision: number; entries: MemoryEntry[] }
export const getNoteMemory = (folder: string, noteId: string, email: string) =>
  invoke<NoteMemory>("agent_note_memory", { folder, noteId, email });
export const returnThought = (folder: string, documentId: string, email: string, revision: number, key: string, result: string) =>
  invoke<void>("agent_return_thought", { folder, documentId, email, revision, key, result });
export const observeWording = (folder: string, documentId: string, email: string,
  observation: { kept: string; proposed: string; restored: boolean }) =>
  invoke<void>("agent_observe_wording", { folder, documentId, email, ...observation });
export const forgetMemory = (folder: string, documentId: string, email: string, revision: number, key: string) =>
  invoke<void>("agent_forget_memory", { folder, documentId, email, revision, key });

export interface WritingReviewContext {
  noteId?: string;
  folder?: string;
  title: string;
  passage: string;
  paragraphCount: number;
  recent: string[];
  dismissed: string[];
  /** Also ask whether the user's edit lets an earlier edit request continue. */
  openRequest?: boolean;
}
/** `continue` runs the request, `done` closes it, `open` leaves it waiting. */
export type RequestState = "continue" | "open" | "done";
export type WritingFocus = "clarity" | "evidence" | "development";
export type WritingScores = Record<WritingFocus, number>;
export const reviewWriting = (context: WritingReviewContext) =>
  invoke<{ revisit?: boolean; focus: WritingFocus | null; anchor: number | null; route: ModelRoute; request?: RequestState | null; scores?: WritingScores }>("agent_review_writing", { context });

export const getStatus = () => invoke<AgentStatus>("agent_status");
export const setupComputerPermissions = (permission: ComputerPermission) =>
  invoke<string>("agent_computer_permissions", { permission });
export const listModels = () => invoke<ModelInfo[]>("agent_list_models");
export const startRun = (request: StartRunRequest) =>
  invoke<{ runId: string }>("agent_start_run", { request });
/** Hands the working agent a message without stopping it. */
export const steerRun = (runId: string, text: string) =>
  invoke<void>("agent_steer_run", { runId, text });
export const cancelRun = (runId: string) =>
  invoke<void>("agent_cancel_run", { runId });
export const toolRespond = (requestId: string, ok: boolean, output: string) =>
  invoke<void>("agent_tool_respond", { requestId, ok, output });
export const researchBriefDefault = () =>
  invoke<string>("agent_research_brief_default");
export const listSkills = () => invoke<Skill[]>("agent_list_skills");
/** Saves an offer as the user saw it; an archive must still match its digest. */
export const installSkill = (
  offer: Pick<SkillOffer, "content" | "source" | "digest" | "archive">,
) =>
  invoke<Skill>("agent_install_skill", {
    offer: {
      content: offer.content,
      source: offer.source,
      digest: offer.digest,
      archive: offer.archive,
    },
  });
export const removeSkill = (name: string) =>
  invoke<void>("agent_remove_skill", { name });
export const setSkillEnabled = (name: string, enabled: boolean) =>
  invoke<Skill>("agent_set_skill_enabled", { name, enabled });
/** Skills at an address: the SKILL.md it points to, or the ones its site publishes. */
export const findSkills = (url: string) =>
  invoke<SkillOffer[]>("agent_find_skills", { url });
/** The note's saved conversations, most recently updated first. */
export const listConversations = (noteId: string) =>
  invoke<ConversationSummary[]>("agent_list_conversations", { noteId });
export const loadConversation = (noteId: string, sessionId: string) =>
  invoke<unknown>("agent_load_conversation", { noteId, sessionId });
export const saveConversation = (
  sessionId: string,
  items: unknown[],
) => invoke<void>("agent_save_conversation", { sessionId, items });
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
