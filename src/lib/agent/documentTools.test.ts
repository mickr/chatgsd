// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Frontmatter } from "../../components/editor/Frontmatter";
import { Wikilink } from "../../components/editor/Wikilink";
import { ScratchBlockMath } from "../../components/editor/MathExtensions";
import { lowlight } from "../../components/editor/lowlight";
import {
  AgentChanges,
  ScratchDocument,
  agentChangesKey,
} from "../../components/editor/AgentChanges";
import {
  captureRunBinding,
  clearDocumentHistory,
  applyTrackedDocuments,
  editedDocuments,
  executeDocumentTool,
  parseDocument,
  serializeDocument,
  trimTrailingEmptyParagraph,
  releaseRunBinding,
} from "./documentTools";

const editors: Editor[] = [];

/** The markdown-relevant extensions of the app's editor (Editor.tsx), so
 * parsing here matches parsing there, custom tokenizers included. */
function openNote(markdown: string): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ScratchDocument,
      AgentChanges,
      StarterKit.configure({ codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
      Link.configure({ openOnClick: false }),
      Image.configure({ inline: false, allowBase64: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit,
      Frontmatter,
      Markdown,
      Wikilink,
      ScratchBlockMath,
    ],
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
  vi.useRealTimers();
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
  it("keeps table-cell changes in one gutter marker outside the scrolling table", async () => {
    const editor = openNote("| Day | Plan |\n| --- | --- |\n| Friday | Walk |");
    await edit(editor, [
      { old_text: "Friday", new_text: "Saturday" },
      { old_text: "Walk", new_text: "Picnic" },
    ]);
    const markers = editor.view.dom.querySelectorAll(".agent-line-marker");
    expect(markers).toHaveLength(1);
    expect(markers[0].parentElement).toBe(editor.view.dom);
    expect(markers[0].closest("table")).toBeNull();
    expect(agentChangesKey.getState(editor.state)!.lineChanges).toHaveLength(2);
  });

  it("maps gutter markers, combines edits in a turn, and removes stale markers after user edits", async () => {
    const editor = openNote("# Plan\n\nLeave Friday at 9.");
    await edit(editor, [{ old_text: "Friday", new_text: "Saturday" }]);
    await edit(editor, [{ old_text: "9", new_text: "10" }]);
    const state = () => agentChangesKey.getState(editor.state)!.lineChanges;
    expect(state()).toHaveLength(1);
    expect(state()[0]).toMatchObject({ before: "Leave Friday at 9.", after: "Leave Saturday at 10." });
    const beforePosition = state()[0].from;
    editor.commands.insertContentAt(1, "Our ");
    expect(state()[0].from).toBe(beforePosition + 4);
    editor.commands.insertContentAt(state()[0].from, "Now ");
    expect(state()).toHaveLength(0);
    expect(editor.view.dom.querySelector(".agent-line-marker")).toBeNull();
  });

  it("records only the applied operation, excluding earlier user edits and later undo", async () => {
    const editor = openNote("Leave Friday.\n\nMy own paragraph.");
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " Added by me.");
    const result = await edit(editor, [{ old_text: "Friday", new_text: "Saturday" }]);
    expect(result.change).toEqual({
      noteTitle: "Note",
      hunks: [{ before: ["Leave Friday."], after: ["Leave Saturday."], line: 1 }],
    });
    editor.commands.undo();
    expect(serializeDocument(editor)).toBe("Leave Friday.\n\nMy own paragraph. Added by me.");
    expect(result.change?.hunks[0].after).toEqual(["Leave Saturday."]);
  });

  it("records selection replacements from the live selection, including deletions", async () => {
    const editor = openNote("Leave Friday.");
    editor.commands.setTextSelection({ from: 7, to: 13 });
    const binding = captureRunBinding(editor, "selection-run")!;
    const result = await executeDocumentTool(editor, binding, "replace_selection", { new_text: "" });
    expect(result.ok).toBe(true);
    expect(result.change?.hunks).toEqual([
      { before: ["Leave Friday."], after: ["Leave ."], line: 1 },
    ]);
  });

  it("keeps review controls for external changes only", () => {
    const editor = openNote("First paragraph.\n\nLast paragraph.\n");
    applyTrackedDocuments(editor, [parseDocument(editor, "First paragraph.\n\nInserted paragraph.\n\nLast paragraph.")], "external", null);
    const controls = editor.view.dom.querySelector(".agent-change-controls");
    expect(controls?.closest("p")?.textContent).toContain("Inserted paragraph.");
  });

  it("tracks an external replacement as the whole word", () => {
    const editor = openNote("Leave **Friday** at 9am.\n");
    applyTrackedDocuments(editor, [parseDocument(editor, "Leave **Saturday** at 9am.\n")], "external", null);
    const [hunk] = hunks(editor);
    const { doc } = editor.state;
    expect(doc.textBetween(hunk.from, hunk.to)).toBe("Saturday");
    const old = hunk.oldSlice.content;
    expect(old.textBetween(0, old.size)).toBe("Friday");
  });

  it("applies a structural edit without highlights and supports normal undo", async () => {
    const editor = openNote("# Title\n\nBody.\n");
    const original = serializeDocument(editor);
    const result = await edit(editor, [
      { old_text: "# Title", new_text: "## Title" },
    ]);
    expect(result.ok).toBe(true);
    expect(serializeDocument(editor).startsWith("## Title")).toBe(true);
    expect(editor.view.dom.querySelector(".agent-change-controls, .agent-change-insert, .agent-change-delete, .agent-change-block, .agent-presence")).toBeNull();
    expect(editor.view.dom.querySelector(".agent-presence-caret")).not.toBeNull();
    editor.commands.undo();
    expect(serializeDocument(editor)).toBe(original);
  });

  it("applies a structural edit second in a batch together with the first", async () => {
    const editor = openNote("# Title\n\nMore text.\n");
    const result = await edit(editor, [
      { old_text: "More text.", new_text: "More words." },
      { old_text: "# Title", new_text: "## Title" },
    ]);
    expect(result.ok).toBe(true);
    expect(hunks(editor)).toHaveLength(0);
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
      const full = parseDocument(editor, markdown.replace(oldText, () => newText));
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
      expected = expected.replace(edit.old_text, () => edit.new_text);
      expect(documents[index].toJSON()).toEqual(
        parseDocument(editor, expected).toJSON(),
      );
    });
  });

  // A construct left open (a fence, an HTML comment) runs past any local
  // window, so these edits must give exactly what a full parse gives.
  const PARAGRAPHS = "Alpha\n\nBravo\n\nCharlie\n\nDelta\n\nEcho\n\nFoxtrot\n";
  const sequential = (note: string, batch: Array<[string, string]>) => {
    const editor = openNote(note);
    const markdown = serializeDocument(editor);
    const edits = batch.map(([old_text, new_text]) => ({ old_text, new_text }));
    const documents = editedDocuments(editor, markdown, edits);
    let expected = markdown;
    edits.forEach((edit, index) => {
      // A replacer function keeps `$$` in new_text literal.
      expected = expected.replace(edit.old_text, () => edit.new_text);
      expect(documents[index].toJSON(), `after edit ${index + 1}`).toEqual(
        parseDocument(editor, expected).toJSON(),
      );
    });
  };

  it("opens a fence that runs to the end of the note, then closes it later", () => {
    sequential(PARAGRAPHS, [
      ["Bravo", "```text\nBravo"],
      ["Echo", "Echo\n```"],
    ]);
  });

  it("closes an existing code block early", () => {
    sequential("Intro\n\n```\nline one\n\nline two\n```\n\nAfter\n\nEnd\n", [
      ["line one", "line one\n```"],
    ]);
  });

  it("opens an HTML comment that swallows later blocks", () => {
    sequential(PARAGRAPHS, [["Bravo", "<!-- Bravo"]]);
  });

  it("adds a link reference that later blocks use", () => {
    sequential("See [docs].\n\nMiddle\n\nMore\n\nEnd\n", [["End", "End\n\n[docs]: https://example.com"]]);
  });

  it("notices a link reference completed by a partial replacement", () => {
    sequential("See [docs].\n\nMiddle\n\nMore\n\n[docs] PENDING\n", [
      ["] PENDING", "]: https://example.com"],
    ]);
  });

  // Block math pairs `$$` with the next `$$` anywhere below, unless a single
  // `$` sits between them, so the closer can be far outside any window.
  it("pairs a new block math opener with a distant closer", () => {
    sequential("Alpha\n\nBravo\n\nCharlie\n\nDelta\n\n$$\n\nFoxtrot\n", [
      ["Bravo", "$$\nBravo"],
    ]);
  });

  it("re-pairs block math when a dollar sign between delimiters goes", () => {
    sequential("$$\n\nPrice $180\n\nMiddle\n\nMore\n\nLater\n\n$$\n\nEnd\n", [
      ["$180", "180"],
    ]);
  });

  it("keeps a horizontal rule mid-note from becoming frontmatter", () => {
    sequential("Intro\n\nOne\n\nTwo\n\n---\n\ntitle: x\n\n---\n\nEnd\n", [
      ["title: x", "title: y"],
    ]);
  });
});

describe("agent presence", () => {
  it("keeps the agent caret mapped but dismisses its range when the user types", async () => {
    const editor = openNote("User paragraph.\n\nTarget: original.");
    editor.commands.setTextSelection(4);
    const binding = captureRunBinding(editor, "pending:run")!;
    const result = await executeDocumentTool(editor, binding, "edit_document", {
      edits: [{ old_text: "Target: original.", new_text: "Target: revised." }],
    });
    expect(result.ok).toBe(true);
    expect(editor.state.selection.from).toBe(4);
    const before = agentChangesKey.getState(editor.state)!.presence["agent"];
    expect(before).toBeDefined();
    expect(editor.state.doc.textBetween(before!.from, before!.to)).toContain("revised");
    editor.view.dispatch(editor.state.tr.insertText("abc", 1));
    const after = agentChangesKey.getState(editor.state)!.presence["agent"];
    expect(after).toEqual({ from: before!.to + 3, to: before!.to + 3 });
    releaseRunBinding(editor, binding, false);
    expect(agentChangesKey.getState(editor.state)!.presence["agent"]).toBeUndefined();
    expect(hunks(editor)).toHaveLength(0);
  });

  it("clears a deleted agent range and preserves an independent reading caret", async () => {
    const editor = openNote("User paragraph.\n\nTarget: original.");
    const binding = captureRunBinding(editor, "run")!;
    await executeDocumentTool(editor, binding, "read_document", {});
    const readCaret = agentChangesKey.getState(editor.state)!.presence["agent"];
    expect(readCaret).toBeDefined();
    expect(readCaret!.from).toBe(readCaret!.to);
    await executeDocumentTool(editor, binding, "edit_document", {
      edits: [{ old_text: "original", new_text: "revised" }],
    });
    const range = agentChangesKey.getState(editor.state)!.presence["agent"];
    expect(range).toBeDefined();
    editor.view.dispatch(editor.state.tr.delete(range!.from, range!.to));
    expect(agentChangesKey.getState(editor.state)!.presence["agent"]).toBeUndefined();
    expect(serializeDocument(editor)).not.toContain("revised");
  });

  it("retains one caret across idle turns and leaves automatic-turn selections attached", async () => {
    const editor = openNote("User paragraph.\n\nTarget: original.");
    const binding = captureRunBinding(editor, "first")!;
    await executeDocumentTool(editor, binding, "edit_document", {
      edits: [{ old_text: "original", new_text: "revised" }],
    });
    releaseRunBinding(editor, binding, true);
    expect(editor.view.dom.querySelectorAll(".agent-presence-caret")).toHaveLength(1);
    editor.commands.setTextSelection({ from: 1, to: 5 });
    const automatic = captureRunBinding(editor, "second", false)!;
    expect(automatic.selectionMarkdown).toBeNull();
    expect(automatic.focusRangeId).toBeNull();
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(5);
    expect(editor.view.dom.querySelectorAll(".agent-presence-caret")).toHaveLength(1);
    releaseRunBinding(editor, automatic);
    expect(editor.view.dom.querySelector(".agent-presence-caret")).toBeNull();
  });

  it("reveals committed words briefly and cancels the reveal when the user types", async () => {
    vi.useFakeTimers();
    const editor = openNote("Original.");
    await edit(editor, [{ old_text: "Original.", new_text: "A few newly written words." }]);
    expect(serializeDocument(editor)).toBe("A few newly written words.");
    expect(editor.view.dom.querySelectorAll(".agent-text-arrival").length).toBeGreaterThan(1);
    vi.advanceTimersByTime(420);
    expect(editor.view.dom.querySelector(".agent-text-arrival")).toBeNull();
    expect(editor.view.dom.querySelector(".agent-presence-caret")).not.toBeNull();
    await edit(editor, [{ old_text: "newly", new_text: "freshly" }]);
    editor.view.dispatch(editor.state.tr.insertText("User: ", 1));
    expect(editor.view.dom.querySelector(".agent-text-arrival")).toBeNull();
    expect(serializeDocument(editor)).toBe("User: A few freshly written words.");
  });

  it("does not let undo restore content from a different note", async () => {
    const editor = openNote("First note.");
    await edit(editor, [{ old_text: "First note.", new_text: "Edited first note." }]);
    editor.commands.setContent(parseDocument(editor, "Second note.").toJSON());
    clearDocumentHistory(editor);
    expect(editor.commands.undo()).toBe(false);
    expect(serializeDocument(editor)).toBe("Second note.");
    await edit(editor, [{ old_text: "Second note.", new_text: "Edited second note." }]);
    editor.commands.undo();
    expect(serializeDocument(editor)).toBe("Second note.");
    expect(editor.commands.undo()).toBe(false);
  });

  it("keeps user typing and an agent edit in separate undo events", async () => {
    const editor = openNote("Start.");
    await edit(editor, [{ old_text: "Start.", new_text: "Revised." }]);
    editor.commands.setTextSelection(4);
    editor.commands.insertContent("user");
    editor.commands.undo();
    expect(serializeDocument(editor)).toBe("Revised.");
    editor.commands.undo();
    expect(serializeDocument(editor)).toBe("Start.");
  });
});
