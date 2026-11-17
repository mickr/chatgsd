// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import {
  AgentChanges,
  ScratchDocument,
  activeFocusRange,
  attachedRange,
  detachSelection,
} from "../../components/editor/AgentChanges";
import { captureRunBinding, executeDocumentTool, releaseRunBinding } from "./documentTools";
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
    Array.from(editor.view.dom.querySelectorAll(".agent-selection"), (node) => node.textContent).join("") || null;

  it("stays attached when focus moves to the sidebar and maps through edits", () => {
    const editor = openNote(NOTE);
    const { from, to } = find(editor, "rain jacket");
    editor.view.dom.dispatchEvent(new FocusEvent("focus"));
    editor.commands.setTextSelection({ from, to });
    // The browser paints a live selection in a focused editor.
    expect(highlight(editor)).toBeNull();

    editor.view.dom.dispatchEvent(new FocusEvent("blur"));
    expect(highlight(editor)).toBe("rain jacket");

    editor.view.dispatch(editor.state.tr.insertText("My ", 1));
    expect(attachedRange(editor)).toEqual({ from: from + 3, to: to + 3 });
    expect(highlight(editor)).toBe("rain jacket");
  });

  it("clears the attachment when the user places the cursor elsewhere", () => {
    const editor = openNote(NOTE);
    Object.assign(editor.storage.scratchDocument, { noteId: "trip", title: "Trip", session: 1 });
    editor.commands.setTextSelection(find(editor, "rain jacket"));
    editor.view.dom.dispatchEvent(new FocusEvent("blur"));
    editor.view.dom.dispatchEvent(new FocusEvent("focus"));
    editor.commands.setTextSelection(find(editor, "Charger").to);
    expect(attachedRange(editor)).toBeNull();
    expect(highlight(editor)).toBeNull();
    expect(captureRunBinding(editor, "run")!.selectionMarkdown).toBeNull();
  });

  it("dismisses a selection with Escape without reattaching on later transactions", () => {
    const editor = openNote(NOTE);
    editor.commands.setTextSelection(find(editor, "rain jacket"));
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(editor.state.selection.empty).toBe(true);
    expect(attachedRange(editor)).toBeNull();
    editor.view.dom.dispatchEvent(new FocusEvent("blur"));
    editor.view.dispatch(editor.state.tr.insertText("My ", 1));
    expect(attachedRange(editor)).toBeNull();
    expect(highlight(editor)).toBeNull();
  });

  it("keeps editor focus when Escape dismisses an attachment before reaching app shortcuts", () => {
    const editor = openNote(NOTE);
    const container = editor.view.dom.parentElement!;
    document.body.append(container);
    const leaveEditor = (event: KeyboardEvent) => {
      if (event.key === "Escape") editor.view.dom.blur();
    };
    window.addEventListener("keydown", leaveEditor);
    try {
      editor.view.focus();
      editor.commands.setTextSelection(find(editor, "rain jacket"));
      editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(attachedRange(editor)).toBeNull();
      expect(document.activeElement).toBe(editor.view.dom);

      // With nothing attached, Escape still reaches the app's navigation shortcut.
      editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(document.activeElement).not.toBe(editor.view.dom);
    } finally {
      window.removeEventListener("keydown", leaveEditor);
      container.remove();
    }
  });

  it("clears both the live selection and highlight when the card is dismissed", () => {
    const editor = openNote(NOTE);
    editor.commands.setTextSelection(find(editor, "rain jacket"));
    detachSelection(editor);
    expect(editor.state.selection.empty).toBe(true);
    editor.view.dom.dispatchEvent(new FocusEvent("blur"));
    expect(attachedRange(editor)).toBeNull();
    expect(highlight(editor)).toBeNull();
  });

  it("lets go when its text is deleted", () => {
    const editor = openNote(NOTE);
    const range = find(editor, "rain jacket");
    editor.commands.setTextSelection(range);
    editor.commands.deleteRange(range);
    expect(attachedRange(editor)).toBeNull();
  });

  it("sends the attachment after focus moves to the composer", () => {
    const editor = openNote(NOTE);
    Object.assign(editor.storage.scratchDocument, { noteId: "trip", title: "Trip", session: 1 });
    editor.commands.setTextSelection(find(editor, "rain jacket"));
    editor.view.dom.dispatchEvent(new FocusEvent("blur"));
    const binding = captureRunBinding(editor, "run")!;
    expect(binding.selectionMarkdown?.trim()).toBe("rain jacket");
    expect(attachedRange(editor)).toBeNull();
  });

  it.each(["click", "Escape", "outside click", "outside Escape", "cursor", "typing"])(
    "dismisses agent highlights after an edit with %s without losing the run target",
    async (action) => {
      const editor = openNote(NOTE);
      Object.assign(editor.storage.scratchDocument, { noteId: "trip", title: "Trip", session: 1 });
      editor.commands.setTextSelection(find(editor, "rain jacket"));
      const binding = captureRunBinding(editor, "run")!;
      const result = await executeDocumentTool(editor, binding, "replace_selection", { new_text: "warm coat" });
      expect(result.ok, result.output).toBe(true);
      expect(highlight(editor)).toBe("warm coat");
      expect(editor.view.dom.querySelector(".agent-working-range")).not.toBeNull();

      if (action === "click") {
        // Exercise the handlers without jsdom's missing coordinate hit testing.
        const event = new MouseEvent("mousedown", { button: 0 });
        editor.view.someProp("handleDOMEvents", (handlers) =>
          handlers.mousedown?.(editor.view, event));
      } else if (action.startsWith("outside")) {
        const composer = document.body.appendChild(document.createElement("textarea"));
        composer.focus();
        const event = action === "outside click"
          ? new MouseEvent("click", { button: 0, bubbles: true, cancelable: true })
          : new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        expect(composer.dispatchEvent(event)).toBe(true);
        expect(document.activeElement).toBe(composer);
        composer.remove();
      } else if (action === "Escape")
        editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else if (action === "cursor")
        editor.commands.setTextSelection(find(editor, "Charger").to);
      else
        editor.view.dispatch(editor.state.tr.insertText("My ", 1));

      expect(highlight(editor)).toBeNull();
      expect(editor.view.dom.querySelector(".agent-working-range")).toBeNull();
      expect(editor.view.dom.querySelector(".agent-presence-caret")).not.toBeNull();
      expect(attachedRange(editor)).toBeNull();
      const target = activeFocusRange(editor)!;
      expect(editor.state.doc.textBetween(target.from, target.to)).toBe("warm coat");
      const followup = await executeDocumentTool(editor, binding, "replace_selection", { new_text: "winter coat" });
      expect(followup.ok, followup.output).toBe(true);
      expect(editor.state.doc.textContent).toContain("winter coat");
      expect(highlight(editor)).toBeNull();
      expect(editor.view.dom.querySelector(".agent-working-range")).toBeNull();
    },
  );

  it.each([true, false])("clears the working highlight at turn completion with a selected passage = %s", async (selected) => {
    const editor = openNote(NOTE);
    Object.assign(editor.storage.scratchDocument, { noteId: "trip", title: "Trip", session: 1 });
    if (selected) editor.commands.setTextSelection(find(editor, "rain jacket"));
    const binding = captureRunBinding(editor, "run")!;
    const result = await executeDocumentTool(editor, binding, "edit_document", { edits: [{ old_text: "rain jacket", new_text: "warm coat" }] });
    expect(result.ok, result.output).toBe(true);
    expect(editor.view.dom.querySelector(".agent-working-range")).not.toBeNull();
    const selection = editor.state.selection.toJSON();
    releaseRunBinding(editor, binding, true);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(highlight(editor)).toBeNull();
    expect(editor.view.dom.querySelector(".agent-working-range")).toBeNull();
    expect(editor.view.dom.querySelector(".agent-presence-caret")).not.toBeNull();
  });
});
