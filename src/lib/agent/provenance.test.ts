import { expect, it } from "vitest";
import { citedEntry, findPriorStepAnswer, provenanceLedger } from "./provenance";
import { argumentMapFor } from "../../components/editor/ArgumentMap";

const items = [
  { type: "user", text: "Find out when the bridge opened." },
  { type: "tool", name: "read_document", ok: true, output: "The whole note" },
  { type: "tool", name: "research", input: { question: "When did the bridge open?" }, ok: true,
    output: "It opened to traffic in May 1937.\nSources:\nhttps://example.com/bridge" },
  { type: "tool", name: "mcp_call", input: { server: "Archive", tool: "lookup", arguments: {} }, ok: false, output: "Failed" },
  { type: "tool", name: "mcp_call", input: { server: "Archive", tool: "search", arguments: {} }, ok: true, output: "Record 42: opening ceremony." },
  { type: "tool", name: "edit_document", input: { edits: [{ old_text: "TBD", new_text: "The bridge opened in May 1937." }] }, ok: true, output: "ok" },
  { type: "text", text: "Done." },
];

it("records what the writer asked and what the tools brought back, skipping reads of the open note and failures", () => {
  const ledger = provenanceLedger(items, "The bridge opened in May 1937.");
  expect(ledger.map(entry => entry.kind)).toEqual(["you", "web", "service", "edit"]);
  expect(ledger.map(entry => entry.id)).toEqual(["e1", "e2", "e3", "e4"]);
  expect(ledger[1]).toMatchObject({ label: "Research: When did the bridge open?", urls: ["https://example.com/bridge"] });
  expect(ledger[2].label).toBe("Archive · search");
  expect(ledger[3].wroteHighlight).toBe(true);
  expect(provenanceLedger(items, "Something else entirely.")[3].wroteHighlight).toBeUndefined();
});

it("keeps the most recent entries when the conversation is long", () => {
  const long = Array.from({ length: 40 }, (_, index) => ({ type: "user", text: `Message ${index}` }));
  const ledger = provenanceLedger(long);
  expect(ledger).toHaveLength(24);
  expect(ledger[ledger.length - 1]).toMatchObject({ id: "e40", text: "Message 39" });
});

it("accepts a cited step only with text really in that entry", () => {
  const ledger = provenanceLedger(items);
  expect(citedEntry(ledger, "e2", "opened to  traffic in May 1937").kind).toBe("web");
  expect(() => citedEntry(ledger, "e2", "opened in 1950")).toThrow(/isn't in context entry/);
  expect(() => citedEntry(ledger, "e9", "anything")).toThrow(/No context entry/);
});

it("anchors a conversation step in the note when its text is there, and numbers it with the visible steps", () => {
  const map = argumentMapFor({
    trace: [null, { from: 10, to: 15 }, { from: 20, to: 25 }], source: { from: 30, to: 40 },
    provenance: [{ kind: "you" }, { kind: "edit" }, null],
    offer: { trace: [{ sure: true }, { sure: true }, { sure: true }] },
  }, null);
  expect(map.steps.map(step => [step.index, step.number, step.via])).toEqual([[1, 1, ["you"]], [2, 2, []]]);
});

it("maps note passages in order and badges the arrow that runs through ledger steps", () => {
  const map = argumentMapFor({
    trace: [{ from: 1, to: 5 }, null, null, { from: 10, to: 15 }], source: { from: 20, to: 30 },
    provenance: [null, { kind: "web" }, { kind: "service" }, null],
    offer: { trace: [{ sure: true }, { sure: true }, { sure: false }, { sure: true }] },
  }, 1);
  expect(map.steps.map(step => [step.index, step.number, step.via])).toEqual([[0, 1, []], [3, 2, ["web", "service"]]]);
  expect(map.decision.via).toEqual([]);
  expect(map.length).toBe(4);
});

it("carries an outcome trace's whole highlight as the block its decision sits in", () => {
  const map = argumentMapFor({ trace: [], source: { from: 20, to: 30 }, provenance: [], offer: { trace: [] },
    outcome: { from: 5, to: 60 } }, null);
  expect(map.decision).toEqual({ from: 20, to: 30, via: [], block: { from: 5, to: 60 } });
});

it("strips the inline agent wrapper and surrounding note JSON so the writer's instruction is never cut off", () => {
  const surrounding = "A".repeat(2200);
  const wrapped = [
    "Inline agent request. Respond to the user's instruction using the current note as context.",
    "Surrounding prose (up to 2,000 document positions on each side):",
    JSON.stringify({ before: surrounding, target: "attached selection", after: surrounding }),
    "User instruction:",
    "Keep the opening grounded in the 1937 ceremony.",
  ].join("\n\n");
  const [entry] = provenanceLedger([{ id: "u1", type: "user", text: wrapped, selection: "May 1937" }]);
  expect(entry).toMatchObject({
    id: "e1",
    kind: "you",
    label: "You said",
    text: "Keep the opening grounded in the 1937 ceremony.\nSelected passage: May 1937",
    itemId: "u1",
  });
  expect(() => citedEntry([entry], "e1", "AAAA")).toThrow(/isn't in context entry/);
});

it("captures answered clarifying questions, discussion replies without spec blocks, and replaced edit text", () => {
  const ledger = provenanceLedger([
    { id: "u1", type: "user", text: "Give me two angles." },
    { id: "a1", type: "text", text: "1. Focus on speed.\n```spec\n{\"op\":\"add\"}\n```\n2. Focus on trust." },
    { id: "q1", type: "question", question: "Which angle should lead?", answer: "Focus on trust." },
    { id: "q2", type: "question", question: "Unanswered?", answer: null },
    { id: "q3", type: "question", question: "Run tool?", answer: "Allow", preview: { root: "r", elements: {} } },
    { id: "u2", type: "user", text: "Rewrite the lead." },
    { id: "e1", type: "tool", name: "edit_document", ok: true, output: "ok",
      input: { edits: [{ old_text: "Speed wins every time.", new_text: "Trust compounds over years." }] } },
    { id: "a2", type: "text", text: "Updated the lead to focus on trust." },
  ], "Trust compounds over years.");
  expect(ledger.map(item => [item.id, item.kind, item.label])).toEqual([
    ["e1", "you", "You said"],
    ["e2", "chat", "Earlier reply"],
    ["e3", "you", "Answered: Which angle should lead?"],
    ["e4", "you", "You said"],
    ["e5", "edit", "Edited this note"],
  ]);
  expect(ledger[1].text).toBe("1. Focus on speed.\n2. Focus on trust.");
  expect(citedEntry(ledger, "e3", "Focus on trust.").itemId).toBe("q1");
  expect(citedEntry(ledger, "e5", "Speed wins every time.").wroteHighlight).toBe(true);
});

it("preserves both the opening and closing conclusions of long tool outputs, plus middle highlight matches", () => {
  const longResearch = `Introductory overview.\n${"x".repeat(2000)}\nConclusion: The treaty was ratified in October 1945.\nhttps://example.com/treaty`;
  const [web] = provenanceLedger([
    { type: "tool", name: "research", input: { question: "Treaty date" }, ok: true, output: longResearch },
  ]);
  expect(web.text.length).toBeLessThanOrEqual(1500);
  expect(citedEntry([web], "e1", "Introductory overview.").urls).toEqual(["https://example.com/treaty"]);
  expect(citedEntry([web], "e1", "The treaty was ratified in October 1945.").kind).toBe("web");

  const midEdit = `${"p".repeat(1100)}\nThe treaty was ratified in October 1945.\n${"q".repeat(1100)}`;
  const [edit] = provenanceLedger([
    { type: "tool", name: "edit_document", input: { edits: [{ old_text: "old", new_text: midEdit }] }, ok: true, output: "ok" },
  ], "The treaty was ratified in October 1945.");
  expect(citedEntry([edit], "e1", "The treaty was ratified in October 1945.").wroteHighlight).toBe(true);
});

it("pins causal turns and required ids even when many later turns follow", () => {
  const history = [
    ...items,
    ...Array.from({ length: 35 }, (_, index) => ({ type: "user", text: `Later chatter ${index}` })),
  ];
  const ledger = provenanceLedger(history, "The bridge opened in May 1937.");
  expect(ledger.slice(0, 4).map(entry => entry.id)).toEqual(["e1", "e2", "e3", "e4"]);
  expect(ledger[ledger.length - 1].id).toBe("e39");

  const withRequired = provenanceLedger(history, "", new Set(["e2"]));
  expect(withRequired[0].id).toBe("e2");
});

it("finds when an earlier writer turn or saved meaning already answered an unsure trace step, without false matches", () => {
  const ledger = provenanceLedger([
    { id: "u1", type: "user", text: "Write a short section on how much the bridge cost to build." },
    { id: "q1", type: "question", question: "Which latency metric?", answer: "p99 tail latency." },
    {
      id: "t1",
      type: "trace",
      offer: { quote: "The bridge opened in May 1937.", explanation: "Opening timeline." },
      confirmed: [{ step: 0, reading: "Pedestrians crossed on Fiesta Day before cars." }],
    },
  ]);

  // Answered by an earlier ask_user turn matching both the passage topic and the inferred detail.
  expect(findPriorStepAnswer(
    { quote: "Latency dropped 40%.", reading: "I took this as p99 latency.", sure: false },
    ledger,
  )?.itemId).toBe("q1");

  // Answered by an earlier confirmed trace step.
  expect(findPriorStepAnswer(
    { quote: "The bridge opened in May 1937.", reading: "Assumed pedestrians crossed before cars.", sure: false },
    ledger,
  )?.itemId).toBe("t1");

  // Casual mention of the passage topic without answering the specific assumption stays unresolved.
  expect(findPriorStepAnswer(
    { quote: "The bridge cost $35 million.", reading: "I assumed 1937 dollars rather than inflation-adjusted.", sure: false },
    ledger,
  )).toBeNull();

  // Saved meaning-* choice anchored to the passage resolves the step directly.
  expect(findPriorStepAnswer(
    { quote: "The bridge cost $35 million.", reading: "I assumed 1937 dollars.", sure: false },
    [],
    [{ key: "meaning-cost", kind: "choice", summary: "The writer means: Nominal 1937 construction cost", quote: "The bridge cost $35 million." }],
  )?.id).toBe("meaning-cost");
});
