// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import {
  AgentChanges,
  ScratchDocument,
  attachedRange,
  detachSelection,
} from "../../components/editor/AgentChanges";
import { captureRunBinding } from "./documentTools";
import { clipPreview, summarizeRange } from "./selection";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function openNote(markdown: string): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, Markdown, ScratchDocument, AgentChanges],
  });
  editor.commands.setContent(editor.storage.markdown.manager.parse(markdown));
  editors.push(editor);
  return editor;
}

/** Document positions of the first occurrence of `text`, within one text node. */
function find(editor: Editor, text: string) {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    const index = node.isText ? node.text!.indexOf(text) : -1;
    if (!found && index >= 0)
      found = { from: pos + index, to: pos + index + text.length };
  });
  if (!found) throw new Error(`${text} isn't in the note`);
  return found as { from: number; to: number };
}

const NOTE = "# Trip\n\n## Packing\n\nBring a rain jacket and a power bank.\n\n- Passport\n- Charger\n";

describe("summarizeRange", () => {
  it("previews the selection as markdown with its section and word count", () => {
    const editor = openNote(NOTE);
    const { from } = find(editor, "rain jacket");
    const { to } = find(editor, "Charger");
    const summary = summarizeRange(editor, from, to)!;
    expect(summary.section).toBe("Packing");
    expect(summary.words).toBe(8);
    expect(summary.markdown).toContain("rain jacket and a power bank.");
    expect(summary.markdown).toContain("- Passport");
    expect(summary.clipped).toBe(false);
  });

  it("places a selection that starts with a heading under that heading's parent", () => {
    const editor = openNote(
      "# Guide\n\n## Entry 3\n\nThree.\n\n## Entry 4\n\nFour.\n\n### Detail\n\nMore.\n",
    );
    const range = (start: string, end: string) =>
      summarizeRange(editor, find(editor, start).from, find(editor, end).to)!;
    expect(range("Entry 4", "Four.").section).toBe("Guide");
    expect(range("Four.", "Four.").section).toBe("Entry 4");
    expect(range("Detail", "More.").section).toBe("Entry 4");
    expect(range("More.", "More.").section).toBe("Detail");
  });
});

describe("clipPreview", () => {
  it("cuts long text at a word boundary and marks it", () => {
    const { markdown, clipped } = clipPreview("word ".repeat(200), 50);
    expect(clipped).toBe(true);
    expect(markdown).toMatch(/word…$/);
    expect(markdown.length).toBeLessThanOrEqual(51);
  });
});

describe("attached selection", () => {
  const highlight = (editor: Editor) =>
    editor.view.dom.querySelector(".agent-selection")?.textContent ?? null;

  it("stays attached and highlighted after focus moves or the user clicks elsewhere", () => {
    const editor = openNote(NOTE);
    const { from, to } = find(editor, "rain jacket");
    editor.view.dom.dispatchEvent(new FocusEvent("focus"));
    editor.commands.setTextSelection({ from, to });
    // The browser paints a live selection in a focused editor.
    expect(highlight(editor)).toBeNull();

    editor.view.dom.dispatchEvent(new FocusEvent("blur"));
    expect(highlight(editor)).toBe("rain jacket");

    editor.view.dom.dispatchEvent(new FocusEvent("focus"));
    editor.commands.setTextSelection(find(editor, "Charger").to);
    expect(attachedRange(editor)).toEqual({ from, to });
    expect(highlight(editor)).toBe("rain jacket");

    // Typing elsewhere moves it along with its text.
    editor.commands.insertContentAt(1, "My ");
    expect(highlight(editor)).toBe("rain jacket");

    detachSelection(editor);
    expect(attachedRange(editor)).toBeNull();
    expect(highlight(editor)).toBeNull();
  });

  it("lets go when its text is deleted", () => {
    const editor = openNote(NOTE);
    const range = find(editor, "rain jacket");
    editor.commands.setTextSelection(range);
    editor.commands.setTextSelection(range.from);
    editor.commands.deleteRange(range);
    expect(attachedRange(editor)).toBeNull();
  });

  it("is what a message is sent with, even after clicking elsewhere", () => {
    const editor = openNote(NOTE);
    Object.assign(editor.storage.scratchDocument, { noteId: "trip", title: "Trip", session: 1 });
    editor.commands.setTextSelection(find(editor, "rain jacket"));
    editor.commands.setTextSelection(find(editor, "Charger").to);
    const binding = captureRunBinding(editor, "run")!;
    expect(binding.selectionMarkdown?.trim()).toBe("rain jacket");
    expect(attachedRange(editor)).toBeNull();
  });
});
