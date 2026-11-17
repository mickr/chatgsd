// @vitest-environment jsdom
import { Editor, Extension, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, expect, it, vi } from "vitest";
import { AgentChanges, agentChangesKey, ScratchDocument } from "../../components/editor/AgentChanges";
import { applyWritingOffer, prepareWritingOffer, refreshWritingOffer, writingOfferChatText } from "./writingOffers";

const editors: Editor[] = [];
const paragraphAttributes = Extension.create({
  name: "testParagraphAttributes",
  addGlobalAttributes: () => [{ types: ["paragraph"], attributes: { test: { default: null } } }],
});
function open(content: string | JSONContent) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ element, extensions: [StarterKit, ScratchDocument, AgentChanges, paragraphAttributes], content,
    editorProps: { handleScrollToSelection: () => true } });
  Object.assign(editor.storage.scratchDocument, { noteId: "note", session: 1 });
  editors.push(editor);
  return editor;
}
const rewrite = (quote = "A rough sentence.", replacement = "A clearer sentence.") => ({
  kind: "rewrite", quote, replacement, explanation: "Make the thought easier to follow.",
  question: null, destination: null, trace: [], sources: [],
});
const move = () => ({ ...rewrite("The example."), kind: "move", replacement: null, destination: "The argument." });

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("prepares a grounded quote without changing the note, focus, or selection", () => {
  const editor = open("<p>Before. A rough sentence. After.</p>");
  editor.commands.setTextSelection(4);
  editor.view.dom.focus();
  const before = editor.getJSON();
  const selection = editor.state.selection.toJSON();
  const offer = prepareWritingOffer(editor, rewrite());
  expect(offer.source).toEqual({ from: 9, to: 26 });
  expect(offer.sourceBlock).toEqual({ from: 0, to: editor.state.doc.firstChild!.nodeSize });
  expect(editor.getJSON()).toEqual(before);
  expect(editor.state.selection.toJSON()).toEqual(selection);
  expect(document.activeElement).toBe(editor.view.dom);
});

it("rewrites marked Unicode text while preserving surrounding marks and the user's focus", () => {
  const editor = open("<p><em>Before.</em> <strong>A 🐈 rough sentence.</strong> <em>After.</em></p>");
  const offer = prepareWritingOffer(editor, rewrite("A 🐈 rough sentence.", "A 🐈 clear sentence."));
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  applyWritingOffer(editor, offer);
  expect(editor.getHTML()).toBe("<p><em>Before.</em> <strong>A 🐈 clear sentence.</strong> <em>After.</em></p>");
  expect(document.activeElement).toBe(input);
});

it("finds one quote across adjacent text nodes with different marks", () => {
  const editor = open("<p>A <strong>rough</strong> sentence.</p>");
  const offer = prepareWritingOffer(editor, rewrite());
  expect(editor.state.doc.textBetween(offer.source.from, offer.source.to)).toBe("A rough sentence.");
});

it("rejects duplicate, cross-block, and non-text inline anchors without changing the note", () => {
  for (const [content, quote] of [
    ["<p>A rough sentence. A rough sentence.</p>", "A rough sentence."],
    ["<p>A rough sentence.</p><p>A rough sentence.</p>", "A rough sentence."],
    ["<p>A rough</p><p>sentence.</p>", "A rough sentence."],
    ["<p>A rough<br>sentence.</p>", "roughsentence"],
  ]) {
    const editor = open(content);
    const before = editor.getJSON();
    expect(() => prepareWritingOffer(editor, rewrite(quote))).toThrow();
    expect(editor.getJSON()).toEqual(before);
  }
});

it("rejects changed quotes but can refresh anchors after unrelated typing", () => {
  const editor = open("<p>Before.</p><p>A rough sentence.</p>");
  const offer = prepareWritingOffer(editor, rewrite());
  editor.commands.insertContentAt(1, "Earlier ");
  const refreshed = refreshWritingOffer(editor, offer)!;
  expect(refreshed.source.from).toBe(offer.source.from + 8);
  applyWritingOffer(editor, offer, "My own revised wording.");
  expect(editor.getText()).toContain("Earlier Before.");
  expect(editor.getText()).toContain("My own revised wording.");
  expect(refreshWritingOffer(editor, offer)).toBeNull();
  const before = editor.getJSON();
  expect(() => applyWritingOffer(editor, offer)).toThrow(/changed/);
  expect(editor.getJSON()).toEqual(before);
});

it("keeps an accepted rewrite separate from earlier and later typing in undo history", () => {
  const editor = open("<p>A rough sentence.</p>");
  const offer = prepareWritingOffer(editor, rewrite());
  editor.commands.insertContentAt(1, "Before. ");
  const beforeAcceptance = editor.getJSON();
  applyWritingOffer(editor, offer);
  const accepted = editor.getJSON();
  editor.commands.insertContentAt(1, "Later. ");
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(accepted);
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(beforeAcceptance);
  editor.commands.redo();
  expect(editor.getJSON()).toEqual(accepted);
});

it("moves the original paragraph atomically, preserving attributes, marks, and a caret within it", () => {
  const editor = open({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "The argument." }] },
    { type: "paragraph", content: [{ type: "text", text: "A bridge." }] },
    { type: "paragraph", attrs: { test: "keep" }, content: [{ type: "text", text: "The example.", marks: [{ type: "bold" }] }] },
  ] });
  const prepared = prepareWritingOffer(editor, move());
  editor.commands.setTextSelection(prepared.source.from + 4);
  editor.view.dom.focus();
  const before = editor.getJSON();
  applyWritingOffer(editor, prepared);
  expect(editor.state.doc.firstChild?.toJSON()).toEqual(before.content![2]);
  expect(editor.getText()).toBe("The example.\n\nThe argument.\n\nA bridge.");
  expect(editor.state.selection.from).toBe(5);
  expect(document.activeElement).toBe(editor.view.dom);
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(before);
});

it("maps a caret outside the moved paragraph to the same text", () => {
  const editor = open("<p>The argument.</p><p>A bridge.</p><p>The example.</p>");
  const prepared = prepareWritingOffer(editor, move());
  editor.commands.setTextSelection(5);
  applyWritingOffer(editor, prepared);
  expect(editor.state.selection.$from.parent.textContent).toBe("The argument.");
  expect(editor.state.selection.$from.parentOffset).toBe(4);
});

it("rejects changed move destinations and invalid structures", () => {
  const editor = open("<p>The argument.</p><p>The example.</p>");
  const offer = prepareWritingOffer(editor, move());
  editor.commands.insertContentAt(5, "changed ");
  const before = editor.getJSON();
  expect(refreshWritingOffer(editor, offer)).toBeNull();
  expect(() => applyWritingOffer(editor, offer)).toThrow(/changed/);
  expect(editor.getJSON()).toEqual(before);
  for (const content of [
    "<h1>The argument.</h1><p>The example.</p>",
    "<p>The argument.</p><ul><li><p>The example.</p></li></ul>",
    "<p>The example.</p><p>The argument.</p>",
    "<p>The argument.</p><p>Some text. The example.</p>",
  ]) expect(() => prepareWritingOffer(open(content), move())).toThrow();
});

it("rejects accepting an offer in another note or another session of the same note", () => {
  const editor = open("<p>A rough sentence.</p>");
  const offer = prepareWritingOffer(editor, rewrite());
  editor.storage.scratchDocument.noteId = "other";
  expect(refreshWritingOffer(editor, offer)).toBeNull();
  expect(() => applyWritingOffer(editor, offer)).toThrow();
  editor.storage.scratchDocument.noteId = "note";
  editor.storage.scratchDocument.session++;
  expect(() => applyWritingOffer(editor, offer)).toThrow();
  expect(editor.getText()).toBe("A rough sentence.");
});

it("grounds each argument-trace step and returns node ranges for the cursor", () => {
  const editor = open("<p>First premise.</p><p>Missing step.</p><p>Conclusion.</p>");
  const offer = prepareWritingOffer(editor, { ...rewrite("Missing step."), kind: "question", replacement: null,
    question: "What connects the premise to the conclusion?", trace: ["First premise.", "Conclusion."] });
  expect(offer.trace.map(range => editor.state.doc.textBetween(range.from, range.to))).toEqual(["First premise.", "Conclusion."]);
  expect(offer.traceBlocks.map(range => editor.state.doc.nodeAt(range.from)?.textContent)).toEqual(["First premise.", "Conclusion."]);
  expect(() => applyWritingOffer(editor, offer)).toThrow(/does not change/);
});

it("requires safe evidence links and rejects incompatible or oversized payloads", () => {
  const editor = open("<p>A rough sentence.</p>");
  const evidence = { ...rewrite(), kind: "evidence", replacement: null,
    sources: [{ title: "Source", url: "https://example.com/source", excerpt: "Relevant evidence." }] };
  expect(prepareWritingOffer(editor, evidence).offer.sources).toHaveLength(1);
  for (const url of ["javascript:alert(1)", "file:///tmp/private", "https://user:secret@example.com", "bad url"])
    expect(() => prepareWritingOffer(editor, { ...evidence, sources: [{ ...evidence.sources[0], url }] })).toThrow();
  for (const invalid of [
    { ...rewrite(), extra: true }, { ...rewrite(), question: "Unexpected question?" },
    { ...rewrite(), replacement: "One paragraph.\nAnother paragraph." }, { ...rewrite(), quote: "x".repeat(6001) },
    { ...rewrite(), sources: evidence.sources }, { ...evidence, sources: [] },
    { ...rewrite(), kind: "question", replacement: null, question: "Why?", trace: ["a", "b", "c", "d"] },
    { ...rewrite(), kind: "question", replacement: null, question: null },
  ]) expect(() => prepareWritingOffer(editor, invalid)).toThrow();
});

it("stages all offer details as readable chat context without editing", () => {
  const editor = open("<p>The argument.</p><p>The example.</p><p>A rough sentence.</p>");
  const before = editor.getJSON();
  for (const args of [
    rewrite(), move(),
    { ...rewrite(), kind: "question", replacement: null, question: "What supports this?", trace: ["The argument."] },
    { ...rewrite(), kind: "evidence", replacement: null,
      sources: [{ title: "Source", url: "https://example.com/source", excerpt: "Relevant evidence." }] },
  ]) {
    const prepared = prepareWritingOffer(editor, args);
    const draft = writingOfferChatText(prepared);
    expect(draft).toContain(args.quote);
    expect(draft).toContain(args.explanation);
    if (prepared.offer.kind === "rewrite") expect(draft).toContain(prepared.offer.replacement);
    if (prepared.offer.kind === "move") expect(draft).toContain(prepared.offer.destination);
    if (prepared.offer.kind === "question") expect(draft).toContain(prepared.offer.question);
    if (prepared.offer.kind === "evidence") expect(draft).toContain(prepared.offer.sources[0].url);
  }
  expect(editor.getJSON()).toEqual(before);
});

it("keeps the writer's edited proposal and answer when staging chat context", () => {
  const editor = open("<p>A rough sentence.</p>");
  const prepared = prepareWritingOffer(editor, rewrite());
  const context = writingOfferChatText(prepared, "The writer's wording.");
  expect(context).toContain("The writer's wording.");
  expect(context).not.toContain("A clearer sentence.");
  const question = prepareWritingOffer(editor, { ...rewrite(), kind: "question", replacement: null, question: "Why?" });
  expect(writingOfferChatText(question, "  Because the premise changed.  ")).toContain("My answer:\nBecause the premise changed.");
  expect(writingOfferChatText(question, "")).not.toContain("My answer:");
  expect(editor.getText()).toBe("A rough sentence.");
});


it("streams an accepted version at the agent caret while committing the marked text atomically", () => {
  vi.useFakeTimers();
  const editor = open("<p>Keep writing here.</p><p><strong>A rough sentence.</strong></p>");
  const proposed = "👩🏽‍💻 A clearer version of the sentence.";
  const offer = prepareWritingOffer(editor, rewrite("A rough sentence.", proposed));
  editor.commands.setTextSelection({ from: 2, to: 5 });
  const selection = editor.state.selection.toJSON();
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  const sources: unknown[] = [];
  editor.on("transaction", ({ transaction }) => {
    if (transaction.docChanged) sources.push(transaction.getMeta(agentChangesKey)?.source);
  });
  applyWritingOffer(editor, offer);
  const state = () => agentChangesKey.getState(editor.state)!;
  const caret = () => editor.view.posAtDOM(editor.view.dom.querySelector(".agent-presence-caret")!, 0);
  expect(sources).toEqual(["agent"]);
  expect(editor.getHTML()).toContain(`<strong>${proposed}</strong>`);
  expect(editor.view.dom.querySelector(".agent-working-range")).toBeNull();
  expect(state().presence.agent.to).toBe(offer.source.from + proposed.length);
  expect(state().arrival?.revealed).toBe(0);
  expect(caret()).toBe(offer.source.from);
  expect(editor.view.dom.querySelector(".agent-text-pending")).not.toBeNull();
  vi.advanceTimersByTime(24);
  const arrival = state().arrival!;
  expect(editor.state.doc.textBetween(arrival.ranges[0].from, arrival.positions[arrival.revealed - 1])).toMatch(/^👩🏽‍💻/);
  expect(caret()).toBeGreaterThan(offer.source.from);
  expect(editor.state.selection.toJSON()).toEqual(selection);
  expect(document.activeElement).toBe(input);
  vi.advanceTimersByTime(1000);
  expect(state().arrival).toBeNull();
  expect(caret()).toBe(state().presence.agent.to);
  expect(editor.view.dom.querySelector(".agent-text-pending")).toBeNull();
});

it("reveals only the moved paragraph at its destination and undoes an unfinished reveal in one step", () => {
  vi.useFakeTimers();
  const editor = open("<p>The argument.</p><p>A bridge.</p><p><strong>The example.</strong></p>");
  const offer = prepareWritingOffer(editor, move());
  const before = editor.getJSON();
  applyWritingOffer(editor, offer);
  const state = () => agentChangesKey.getState(editor.state)!;
  expect(state().presence.agent).toEqual({ from: 13, to: 13 });
  expect(state().arrival?.ranges).toEqual([{ from: 1, to: 13 }]);
  expect(editor.view.dom.querySelector(".agent-text-pending")?.textContent).toBe("The example.");
  expect(editor.getHTML()).toBe("<p><strong>The example.</strong></p><p>The argument.</p><p>A bridge.</p>");
  vi.advanceTimersByTime(48);
  expect(state().arrival!.revealed).toBeGreaterThan(0);
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(before);
  expect(state().arrival).toBeNull();
  vi.advanceTimersByTime(4000);
  expect(editor.getJSON()).toEqual(before);
});

it("skips acceptance animation for reduced motion while retaining agent presence and one-step undo", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const editor = open("<p>A rough sentence.</p>");
  const offer = prepareWritingOffer(editor, rewrite());
  const before = editor.getJSON();
  applyWritingOffer(editor, offer);
  const state = agentChangesKey.getState(editor.state)!;
  expect(editor.getText()).toBe("A clearer sentence.");
  expect(state.arrival).toBeNull();
  expect(state.presence.agent).toEqual({ from: 20, to: 20 });
  expect(editor.view.dom.querySelector(".agent-text-pending")).toBeNull();
  expect(editor.view.dom.querySelector(".agent-presence-caret")).not.toBeNull();
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(before);
});
