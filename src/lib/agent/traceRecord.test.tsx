// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it } from "vitest";
import {
  changedMeaningQuotes,
  isTraceRecord,
  locateMeaningAnchors,
  mapMeaningAnchors,
  pendingTraceContext,
  traceRecord,
} from "./traceRecord";
import { provenanceLedger } from "./provenance";
import type { PreparedWritingOffer } from "./writingOffers";
import { TraceRecordCard } from "../../components/agent/TraceRecordCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const prepared = (requested: PreparedWritingOffer["requested"], trace = true): PreparedWritingOffer => ({
  offer: { kind: "question", quote: "Something to sit on.", explanation: "The rug came from your first message.",
    replacement: null, question: "Is it a picnic rug?", destination: null, sources: [],
    trace: trace ? [{ quote: "Bring a rug", reading: "You asked for comfort.", sure: true, source: "e1" },
      { quote: "Something to sit on.", reading: "So I kept it.", sure: false }] : [] },
  noteId: "trip", documentSession: 1, requested, source: { from: 1, to: 5 }, sourceBlock: { from: 0, to: 6 },
  destination: null, trace: [null, { from: 1, to: 5 }], traceBlocks: [{ from: 0, to: 6 }],
  provenance: [{ id: "e1", kind: "you", label: "You said", text: "Bring a rug" }, null],
  outcome: { from: 0, to: 40, text: "Pack light. Something to sit on.", paragraphs: 2 },
});

it("keeps only the maps the writer asked for", () => {
  expect(traceRecord("run-1", prepared("outcome"))).toMatchObject({ id: "trace:run-1", type: "trace",
    outcome: { text: "Pack light. Something to sit on.", paragraphs: 2 }, corrections: [] });
  expect(traceRecord("run-1", prepared("realign"))).not.toBeNull();
  expect(traceRecord("run-1", prepared(undefined))).toBeNull();
  expect(traceRecord("run-1", prepared("rewrite"))).toBeNull();
  expect(traceRecord("run-1", prepared("outcome", false))).toBeNull();
});

it("tells the main agent about each map once, with the writer's corrections", () => {
  const first = { ...traceRecord("run-1", prepared("outcome"))!,
    corrections: [{ step: 1, quote: "Something to sit on.", readAs: "So I kept it.", meant: "A picnic rug, not a chair." }] };
  const delivered = { ...traceRecord("run-0", prepared("question"))!, delivered: true as const };
  const pending = pendingTraceContext([{ type: "user" }, delivered, first]);
  expect(pending?.ids).toEqual(["trace:run-1"]);
  expect(pending?.text).toContain('Traced back from: "Pack light. Something to sit on."');
  expect(pending?.text).toContain('1. [You said] "Bring a rug" You asked for comfort.');
  expect(pending?.text).toContain("(unsure) So I kept it.");
  expect(pending?.text).toContain("What we learned: The rug came from your first message.");
  expect(pending?.text).toContain('The writer corrected step 2: it was read as "So I kept it.", but they meant: A picnic rug, not a chair.');
  expect(pendingTraceContext([delivered])).toBeNull();
});

it("lets a later trace cite an earlier map", () => {
  const record = { ...traceRecord("run-1", prepared("outcome"))!, corrections: [{ step: 0, quote: "q", readAs: "r", meant: "A rug." }] };
  const [entry] = provenanceLedger([record]);
  expect(entry).toMatchObject({ kind: "trace", label: 'Earlier map of "Something to sit on."' });
  expect(entry.text).toBe("What we learned: The rug came from your first message.\nThe writer corrected step 1: A rug.");
});

it("shows a kept map with its sources and corrections", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const record = { ...traceRecord("run-1", prepared("outcome"))!, corrections: [{ step: 1, quote: "q", readAs: "r", meant: "A picnic rug." }] };
  act(() => root.render(<TraceRecordCard record={record} />));
  expect(container.querySelector("summary")?.textContent).toContain("Traced back from “Pack light. Something to sit on.”2 steps · 1 corrected");
  const steps = container.querySelectorAll(".argument-map-steps > li");
  expect(steps[0].textContent).toContain("You said");
  expect(steps[1].textContent).toContain("You meant: A picnic rug.");
  expect(steps[2].textContent).toContain("What we learned: The rug came from your first message.");
  act(() => root.unmount());
});

it("takes a step only in the conversation to the message it came from, or shows it in full when that isn't on screen", async () => {
  const { showTranscriptItem } = await import("./transcriptLink");
  const { OffPageStep } = await import("../../components/agent/ui/writingOfferContext");
  const panel = document.body.appendChild(document.createElement("aside"));
  panel.className = "agent-panel";
  panel.innerHTML = `<div data-transcript-item="m1" class="contents"><p class="agent-panel-user">Bring a rug</p></div>`;
  const message = panel.querySelector("p")!;
  message.scrollIntoView = () => {};
  expect(showTranscriptItem("m1")).toBe(true);
  expect(message.classList.contains("agent-transcript-flash")).toBe(true);
  expect(showTranscriptItem("gone")).toBe(false);
  expect(showTranscriptItem(undefined)).toBe(false);

  const container = panel.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let expanded = false;
  const draw = () => act(() => root.render(<OffPageStep entry={{ id: "e1", kind: "you", label: "You said", text: "Bring a rug, and the flask.", itemId: "gone" }}
    quote="Bring a rug" expanded={expanded} onExpand={() => { expanded = !expanded; draw(); }} />));
  draw();
  expect(container.querySelector("blockquote")?.textContent).toBe("Bring a rug");
  act(() => container.querySelector("button")!.click());
  expect(container.querySelector("pre")?.textContent).toBe("Bring a rug, and the flask.");
  expect(container.querySelector("button")?.textContent).toBe("Hide source");
  act(() => root.unmount());
});

it("keeps each ledger entry's conversation item", () => {
  const [entry] = provenanceLedger([{ id: "m1", type: "user", text: "Bring a rug" }]);
  expect(entry).toMatchObject({ id: "e1", itemId: "m1" });
});

it("validates saved trace records and maps meaning anchors across live edits", () => {
  const valid = traceRecord("run-1", prepared("outcome"))!;
  expect(isTraceRecord(valid as unknown as Record<string, unknown>)).toBe(true);
  expect(isTraceRecord({ id: "trace:bad", type: "trace", offer: { quote: 1 } })).toBe(false);
  expect(isTraceRecord({ ...valid, provenance: "bad" } as unknown as Record<string, unknown>)).toBe(false);

  const editor = new Editor({ extensions: [StarterKit], content: "<p>Pack light. Something to sit on.</p>" });
  let anchors = locateMeaningAnchors(editor.state.doc, [
    { key: "meaning-abc", kind: "choice", quote: "Something to sit on." },
    { key: "wording-xyz", kind: "choice", quote: "Pack light." },
  ]);
  expect(anchors).toHaveLength(1);
  expect(changedMeaningQuotes(editor.state.doc, anchors)).toEqual([]);

  const insertPos = 1 + editor.getText().indexOf("to sit on.");
  const tr = editor.state.tr.insertText("soft ", insertPos);
  editor.view.dispatch(tr);
  anchors = mapMeaningAnchors(editor.state.doc, anchors, tr.mapping.map.bind(tr.mapping));
  expect(changedMeaningQuotes(editor.state.doc, anchors)).toEqual([
    { key: "meaning-abc", quote: "Something soft to sit on." },
  ]);
  editor.destroy();
});
