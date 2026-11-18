// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it } from "vitest";
import { setChangeMeta } from "../../components/editor/AgentChanges";
import { trackWriterCorrection } from "./writerCorrection";

it("remembers a reversed agent edit, retracts it on redo, and ignores the writer's own undo", () => {
  const editor = new Editor({ extensions: [StarterKit], content: "<p>It may work.</p>" });
  const track = trackWriterCorrection();
  const seen: unknown[] = [];
  editor.on("transaction", ({ transaction }) => { const result = track(transaction); if (result) seen.push(result); });
  editor.view.dispatch(setChangeMeta(editor.state.tr.insertText("will", 4, 7), { source: "agent" }));
  editor.commands.undo();
  editor.commands.redo();
  expect(seen).toEqual([true, false].map(restored => ({ kept: "It may work.", proposed: "It will work.", restored })));
  editor.commands.insertContent("Claim: ");
  editor.commands.undo();
  expect(seen).toHaveLength(2);
  editor.destroy();
});
