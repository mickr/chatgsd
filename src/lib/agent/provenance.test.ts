import { expect, it } from "vitest";
import { citedEntry, provenanceLedger } from "./provenance";
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
