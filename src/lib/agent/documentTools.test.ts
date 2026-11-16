// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import {
  AgentChanges,
  ScratchDocument,
  agentChangesKey,
} from "../../components/editor/AgentChanges";
import {
  captureRunBinding,
  executeDocumentTool,
  serializeDocument,
  trimTrailingEmptyParagraph,
} from "./documentTools";

const editors: Editor[] = [];

function openNote(markdown: string): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, TableKit, Markdown, ScratchDocument, AgentChanges],
  });
  editor.commands.setContent(editor.storage.markdown.manager.parse(markdown));
  Object.assign(editor.storage.scratchDocument, {
    noteId: "note",
    title: "Note",
    session: 1,
  });
  editors.push(editor);
  return editor;
}

function hunks(editor: Editor) {
  return agentChangesKey.getState(editor.state)?.hunks ?? [];
}

async function edit(
  editor: Editor,
  edits: Array<{ old_text: string; new_text: string }>,
) {
  const binding = captureRunBinding(editor, "run");
  if (!binding) throw new Error("No note is open");
  return executeDocumentTool(editor, binding, "edit_document", { edits });
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("serializeDocument", () => {
  it("writes empty table cells as spaces and reloads them as empty", () => {
    const editor = openNote("| A | B |\n| --- | --- |\n| x |  |\n");
    const saved = trimTrailingEmptyParagraph(serializeDocument(editor));
    expect(saved).not.toContain("&nbsp;");
    expect(openNote(saved).getJSON()).toEqual(editor.getJSON());
  });

  it("leaves table-like lines inside fenced code untouched", () => {
    const code = "```md\n| &nbsp; | y |\n```";
    const nested = "- item\n\n  ```\n  | &nbsp; |\n  ```";
    const markdown = serializeDocument(openNote(`${code}\n\n${nested}\n`));
    expect(markdown).toContain("| &nbsp; | y |");
    expect(markdown).toContain("  | &nbsp; |");
  });

  it("keeps a table cell whose text is literally &nbsp;", () => {
    const editor = openNote("| A |\n| --- |\n| x |\n");
    editor.commands.command(({ tr, state }) => {
      let cellText = -1;
      state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "x") cellText = pos;
      });
      tr.insertText("&nbsp;", cellText, cellText + 1);
      return true;
    });
    expect(serializeDocument(editor)).toContain("&nbsp;");
  });

  it("does not let an unrelated agent edit change a code example", async () => {
    const editor = openNote("Intro line.\n\n```md\n| &nbsp; | y |\n```\n");
    const result = await edit(editor, [
      { old_text: "Intro line.", new_text: "Opening line." },
    ]);
    expect(result.ok).toBe(true);
    expect(serializeDocument(editor)).toContain("```md\n| &nbsp; | y |\n```");
  });
});

describe("trimTrailingEmptyParagraph", () => {
  it("drops only the trailing empty paragraph", () => {
    expect(trimTrailingEmptyParagraph("> Quote\n\n&nbsp;")).toBe("> Quote");
    expect(trimTrailingEmptyParagraph("A\n\n&nbsp;\n\nB")).toBe(
      "A\n\n&nbsp;\n\nB",
    );
  });
});

describe("edit_document", () => {
  it("tracks a replaced word as the whole word", async () => {
    const editor = openNote("Leave **Friday** at 9am.\n");
    await edit(editor, [{ old_text: "**Friday**", new_text: "**Saturday**" }]);
    const [hunk] = hunks(editor);
    const { doc } = editor.state;
    expect(doc.textBetween(hunk.from, hunk.to)).toBe("Saturday");
    const old = hunk.oldSlice.content;
    expect(old.textBetween(0, old.size)).toBe("Friday");
  });

  it("changes the first block's type and rejects back to the original", async () => {
    const editor = openNote("# Title\n\nBody.\n");
    const original = serializeDocument(editor);
    const result = await edit(editor, [
      { old_text: "# Title", new_text: "## Title" },
    ]);
    expect(result.ok).toBe(true);
    expect(serializeDocument(editor).startsWith("## Title")).toBe(true);
    editor.commands.rejectAgentChange(hunks(editor)[0].id);
    expect(serializeDocument(editor)).toBe(original);
  });

  it("applies a structural edit second in a batch together with the first", async () => {
    const editor = openNote("# Title\n\nMore text.\n");
    const result = await edit(editor, [
      { old_text: "More text.", new_text: "More words." },
      { old_text: "# Title", new_text: "## Title" },
    ]);
    expect(result.ok).toBe(true);
    expect(hunks(editor)).toHaveLength(2);
    expect(serializeDocument(editor)).toBe("## Title\n\nMore words.");
  });

  it("applies nothing when any edit in the batch fails", async () => {
    const editor = openNote("Pack bags.\n\nDrive. Drive.\n");
    const before = editor.getJSON();
    const ambiguous = await edit(editor, [
      { old_text: "Pack", new_text: "Pack the" },
      { old_text: "Drive", new_text: "Fly" },
    ]);
    expect(ambiguous).toEqual({
      ok: false,
      output: "Edit 2 matches 2 places: include more surrounding text.",
    });
    expect(editor.getJSON()).toEqual(before);
    expect(hunks(editor)).toHaveLength(0);
  });
});
