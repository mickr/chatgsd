// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { droppedFacts, factsIn, noteMap, sharedTerms } from "./noteMap";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

const NOTE = `# CDUI pages

CDUI pages ship on web and mobile through one host.

## Context and scope

Box web teams fork shared components and build their own page headers. This leads to different Blueprint versions, including a separate build in Hubs. Automate owns 70+ right-panel permutations.

The team that hosts a page also maintains its integrations.

## Risks

Shared components drift when Blueprint versions differ. Hubs keeps its own build until Q3. The 70+ permutations need an owner.`;

function mapOf(passageStart: string) {
  const editor = new Editor({ element: document.createElement("div"), extensions: [StarterKit, Markdown] });
  editors.push(editor);
  editor.commands.setContent(editor.storage.markdown.manager.parse(NOTE));
  let range = { from: 0, to: 0 };
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent.startsWith(passageStart))
      range = { from: pos + 1, to: pos + 1 + node.content.size };
  });
  return noteMap(editor.state.doc, "CDUI pages", range);
}

it("maps where the note is going and the whole section a passage sits in", () => {
  const map = mapOf("Box web teams");
  expect(map.opening).toBe("CDUI pages ship on web and mobile through one host.");
  expect(map.outline).toEqual(["CDUI pages", "  Context and scope", "  Risks"]);
  expect(map.section?.heading).toBe("Context and scope");
  // The neighbouring paragraph is in it, so the agent can see what it already says; the next section isn't.
  expect(map.section?.text).toContain("The team that hosts a page");
  expect(map.section?.text).not.toContain("Shared components drift");
});

it("keeps the names, numbers and phrases a later section relies on", () => {
  const { keep } = mapOf("Box web teams");
  expect(keep).toEqual(expect.arrayContaining(["Hubs", "70+", "shared components"]));
  expect(keep.some((term) => term.includes("Blueprint"))).toBe(true);
  // Only in this passage: tightening may cut it without breaking anything else.
  expect(keep).not.toContain("Automate");
  // Capitals that only start a sentence are grammar, not names.
  expect(keep).not.toContain("This");
  expect(keep).not.toContain("Box");
});

it("takes names and numbers as the facts an edit must keep, not capitals that only start a sentence", () => {
  expect(factsIn("This ships in Q3 for 70+ teams. Hubs keeps its own CDUI build.")).toEqual(["70+", "Q3", "CDUI"]);
});

it("catches what an edit dropped from the note, checked by code rather than the model's word", () => {
  const before = "Hubs keeps its own build until Q3. Automate owns 70+ permutations. Later: Hubs again, and the 70+ list.";
  const passage = "Hubs keeps its own build until Q3. Automate owns 70+ permutations.";
  // Q3 is gone from the note entirely; 70+ survives elsewhere, so cutting it here is fine on its own.
  const after = "Hubs keeps its own build. Automate owns the permutations. Later: Hubs again, and the 70+ list.";
  expect(droppedFacts(passage, before, after)).toEqual(["Q3"]);
  // A term the rest of the note relies on must stay in the passage too.
  expect(droppedFacts(passage, before, after, ["70+"])).toEqual(["Q3", "70+"]);
  expect(droppedFacts(passage, before, before, ["70+"])).toEqual([]);
});

it("counts a term only where it stands alone, not inside a longer word", () => {
  expect(sharedTerms("We rely on Hub routing.", "The Hubs team owns it.")).not.toContain("Hub");
  expect(sharedTerms("Ship by 2027 or later.", "Budget for 20270 units.")).not.toContain("2027");
  expect(sharedTerms("Ship by 2027 or later.", "The 2027 plan.")).toContain("2027");
});
