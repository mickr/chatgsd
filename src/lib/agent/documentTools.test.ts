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
  editedDocuments,
  executeDocumentTool,
  parseDocument,
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
  it("puts review controls inside an inserted paragraph, not the next one", async () => {
    const editor = openNote("First paragraph.\n\nLast paragraph.\n");
    await edit(editor, [
      {
        old_text: "First paragraph.",
        new_text: "First paragraph.\n\nInserted paragraph.",
      },
    ]);
    const controls = editor.view.dom.querySelector(".agent-change-controls");
    expect(controls?.closest("p")?.textContent).toContain("Inserted paragraph.");
  });

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

describe("editedDocuments", () => {
  const NOTE = [
    "# Trip notes",
    "",
    "Intro paragraph with **bold** text.",
    "",
    "- tight one",
    "- tight two",
    "",
    "1. first",
    "2. second",
    "",
    "```js",
    "const a = 1;",
    "",
    "const b = 2;",
    "```",
    "",
    "> A quote",
    "> over lines",
    "",
    "| Day | Plan |",
    "| --- | --- |",
    "| Mon | Hike |",
    "",
    "---",
    "",
    "## Packing",
    "",
    "- loose one",
    "",
    "- loose two",
    "",
    "Closing paragraph.",
  ].join("\n");

  const EDITS: Array<[string, string]> = [
    ["bold", "strong"],
    ["Intro paragraph with **bold** text.", "Intro paragraph.\n\n- now a list item"],
    ["- tight two", "- tight two\n- tight three"],
    ["- tight two\n", ""],
    ["const a = 1;\n", "const a = 1;\n\n\nconst z = 0;\n"],
    ["> over lines", "> over lines\n\nNot a quote"],
    ["| Mon | Hike |", "| Mon | Hike |\n| Tue | Swim |"],
    ["---\n\n## Packing", "## Packing"],
    ["## Packing", "Packing\n======="],
    ["Closing paragraph.", "Closing paragraph.\n\n- appended item"],
    ["# Trip notes\n\nIntro", "# Trip notes\nIntro"],
    ["2. second\n\n```js", "2. second\n3. third\n\n```js"],
  ];

  it("matches a full parse for every kind of block edit", () => {
    const editor = openNote(NOTE);
    const markdown = serializeDocument(editor);
    for (const [oldText, newText] of EDITS) {
      const [local] = editedDocuments(editor, markdown, [
        { old_text: oldText, new_text: newText },
      ]);
      const full = parseDocument(editor, markdown.replace(oldText, newText));
      expect(local.toJSON(), `${oldText} → ${newText}`).toEqual(full.toJSON());
    }
  });

  it("matches a full parse across a sequential batch", () => {
    const editor = openNote(NOTE);
    const markdown = serializeDocument(editor);
    const batch = [
      { old_text: "Intro paragraph", new_text: "Opening paragraph" },
      { old_text: "- tight two", new_text: "- tight two\n- tight three" },
      { old_text: "- tight three", new_text: "- tight 3" },
      { old_text: "Closing paragraph.", new_text: "Closing.\n\nPostscript." },
      { old_text: "Postscript.", new_text: "P.S." },
    ];
    let expected = markdown;
    const documents = editedDocuments(editor, markdown, batch);
    batch.forEach((edit, index) => {
      expected = expected.replace(edit.old_text, edit.new_text);
      expect(documents[index].toJSON()).toEqual(
        parseDocument(editor, expected).toJSON(),
      );
    });
  });
});
