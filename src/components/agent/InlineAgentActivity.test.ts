import { expect, it } from "vitest";
import type { Conversation, TranscriptItem } from "../../context/AgentContext";
import { inlineActivity, inlineTurnPreview } from "./InlineAgentActivity";

const conversation = (items: TranscriptItem[], patch: Partial<Conversation> = {}): Conversation => ({
  items, runId: "run", sessionId: "session", context: null, error: null, cancelled: false, ...patch,
});

it.each([
  ["read_document", "reading"], ["edit_document", "editing"],
  ["replace_selection", "editing"], ["research", "researching"],
] as const)("shows %s only while that tool is pending", (name, expected) => {
  const tool: TranscriptItem = { id: "tool", type: "tool", name, input: {} };
  expect(inlineActivity(conversation([tool]), false, false, false).state).toBe(expected);
  expect(inlineActivity(conversation([{ ...tool, ok: true, output: "done" }]), false, false, false).state).toBe("thinking");
});

it("does not reuse an unfinished tool from a previous turn", () => {
  const items: TranscriptItem[] = [
    { id: "old", type: "tool", name: "edit_document", input: {} },
    { id: "new", type: "user", text: "Explain this" },
  ];
  expect(inlineActivity(conversation(items), false, false, false).state).toBe("thinking");
});

it("distinguishes waiting, writing, completion, cancellation, and errors", () => {
  const reply: TranscriptItem = { id: "reply", type: "text", text: "Revised." };
  expect(inlineActivity(conversation([reply]), false, false, false).state).toBe("responding");
  expect(inlineActivity(conversation([reply]), true, false, false).state).toBe("waiting");
  expect(inlineActivity(conversation([reply], { runId: null }), false, false, false).state).toBe("done");
  expect(inlineActivity(conversation([reply], { runId: null, cancelled: true }), false, false, false).state).toBe("paused");
  expect(inlineActivity(conversation([], { error: { kind: "other", message: "Offline" } }), false, false, false).state).toBe("error");
});

it("previews the latest turn without leaking inline prompt context or a previous reply", () => {
  const items: TranscriptItem[] = [
    { id: "first", type: "user", text: "An earlier request" },
    { id: "reply", type: "text", text: "The earlier reply" },
    { id: "second", type: "user", text: "Inline edit request. Apply the instruction directly in the current note.\nPrivate surrounding prose\n\nUser instruction:\n\nShorten this paragraph" },
    { id: "read", type: "tool", name: "read_document", input: {} },
  ];
  expect(inlineTurnPreview(items)).toEqual({ turn: 2, text: "Shorten this paragraph" });
  items.push({ id: "current", type: "text", text: "I'm tightening the opening.\nKeeping your examples." });
  expect(inlineTurnPreview(items)).toEqual({ turn: 2, text: "I'm tightening the opening. Keeping your examples." });
});

it("counts automatic check-ins as turns and does not carry forward stale text", () => {
  expect(inlineTurnPreview([
    { id: "old", type: "text", text: "Earlier response" },
    { id: "check", type: "activity", text: "You edited the note. Checking in…" },
    { id: "tool", type: "tool", name: "read_document", input: {} },
  ])).toEqual({ turn: 2, text: "You edited the note. Checking in…" });
});

it.each([
  '```spec\n{"op":"add","path":"/root","value":"card"}\n```',
  '```spec\n{"op":"add","path":"/root","value":"card"}\n{"op":"add","path":"/elements',
])("retains the request for complete or unfinished spec-only replies", (reply) => {
  expect(inlineTurnPreview([
    { id: "user", type: "user", text: "Show the comparison" },
    { id: "reply", type: "text", text: reply },
  ])).toEqual({ turn: 1, text: "Show the comparison" });
});

it("previews prose around UI specs without exposing their patches", () => {
  expect(inlineTurnPreview([
    { id: "user", type: "user", text: "Show the comparison" },
    { id: "reply", type: "text", text: 'Here are the options.\n```spec\n{"op":"add","path":"/root","value":"card"}\n```\nThe first is cheaper.' },
  ])).toEqual({ turn: 1, text: "Here are the options. The first is cheaper." });
});

it("describes active swarm coordination, checking, and draining states", () => {
  const swarm = (status: "running" | "checking" | "draining" | "completed"): TranscriptItem => ({
    id: "run:swarm-1",
    type: "swarm",
    runId: "run",
    swarmId: "swarm-1",
    goal: "Review draft",
    workers: [
      { workerId: "w1", name: "Clarity", role: "Style", status, steps: 1, updatedAt: 1 },
      { workerId: "w2", name: "Facts", role: "Claims", status: "completed", steps: 2, updatedAt: 1 },
    ],
  });
  expect(inlineActivity(conversation([swarm("running")]), false, false, false).label).toBe("Coordinating 1 agent");
  expect(inlineActivity(conversation([swarm("checking")]), false, false, false).label).toBe("Checking on agents");
  expect(inlineActivity(conversation([swarm("draining")]), false, false, false).label).toBe("Draining 1 agent");
  expect(inlineActivity(conversation([swarm("completed")]), false, false, false).label).toBe("Thinking");
  expect(
    inlineActivity(
      conversation([{ id: "cmd", type: "tool", name: "shell_command", input: { command: "python3 test.py" } }]),
      false,
      false,
      false,
    ).label,
  ).toBe("Running command");
});
