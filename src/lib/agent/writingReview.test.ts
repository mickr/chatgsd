// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it } from "vitest";
import { splitStarters, writingPassage } from "./writingReview";

it("sends valid Unicode when the passage budget lands inside an emoji", () => {
  const editor = new Editor({ extensions: [StarterKit], content: `<p>${"A".repeat(5994)}😀</p>` });
  expect(writingPassage(editor).passage).toBe("[p0] " + "A".repeat(5994));
  editor.destroy();
});

it("maps classifier labels to real paragraph nodes, including nested paragraphs", () => {
  const editor = new Editor({ extensions: [StarterKit], content: "<h1>Heading</h1><p>A claim.</p><ul><li><p>A supporting detail.</p></li></ul>" });
  const { passage, ranges } = writingPassage(editor);
  expect(passage).toContain("[p1] A claim.");
  expect(ranges.map(range => editor.state.doc.nodeAt(range.from)?.textContent)).toEqual(["Heading", "A claim.", "A supporting detail."]);
  editor.destroy();
});

it("bounds context and anchor counts while preserving the text around a distant cursor", () => {
  const editor = new Editor({ extensions: [StarterKit], content: `<p>${"A".repeat(10000)}TARGET${"B".repeat(10000)}</p>` });
  editor.commands.setTextSelection(10001);
  const { passage, ranges } = writingPassage(editor);
  expect(passage.length).toBeLessThanOrEqual(6000);
  expect(passage).toContain("TARGET");
  expect(ranges).toHaveLength(1);
  editor.commands.setContent("<p>Example</p>".repeat(100));
  expect(writingPassage(editor).ranges.length).toBeLessThanOrEqual(24);
  editor.destroy();
});

it("separates the agent's observation from the next moves it proposes for the note", () => {
  expect(splitStarters("This claim needs a source.\n\nStarters:\nConnect Venus to the opening\n- Find a source for the Venus day\n2. \"Cut the calendar claim\"\n"))
    .toEqual({ advice: "This claim needs a source.\n\n", starters: ["Connect Venus to the opening", "Find a source for the Venus day", "Cut the calendar claim"] });
  // A reply without the block is all observation.
  expect(splitStarters("Starters: are a good idea here.")).toEqual({ advice: "Starters: are a good idea here.", starters: [] });
  expect(splitStarters("**Starters**\nFind a source\nCut the claim").starters).toEqual(["Find a source", "Cut the claim"]);
  // At most four, no repeats, and nothing too long to be a button.
  expect(splitStarters(`Starters:\na\na\nb\n${"x".repeat(81)}\nc\nd\ne`).starters).toEqual(["a", "b", "c", "d"]);
});

it("never shows a starters-only reply as advice, even without the Starters: label", () => {
  const reply = "Trace AX's testing role\nClarify the JSON-render comparison\nSummarize the bandwidth discussion\nPull out the design questions";
  expect(splitStarters(reply, true)).toEqual({ advice: "", starters: [
    "Trace AX's testing role", "Clarify the JSON-render comparison", "Summarize the bandwidth discussion", "Pull out the design questions",
  ] });
  expect(splitStarters(`Looks good.\nStarters:\n${reply}`, true)).toEqual({ advice: "", starters: reply.split("\n") });
});
