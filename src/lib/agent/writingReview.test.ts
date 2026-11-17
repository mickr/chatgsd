// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it } from "vitest";
import { writingPassage } from "./writingReview";

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
