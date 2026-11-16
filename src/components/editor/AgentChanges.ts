import { Extension, type Editor } from "@tiptap/core";
import { DOMSerializer, type Slice } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import { useCallback, useSyncExternalStore } from "react";

export interface AgentChangeSummary {
  id: string;
  origin: "agent" | "external";
  runId: string | null;
}
export interface AgentChange extends AgentChangeSummary {
  from: number;
  to: number;
  oldSlice: Slice;
}
interface FocusRange {
  id: string;
  from: number;
  to: number;
}
interface ChangeState {
  hunks: AgentChange[];
  focusRanges: FocusRange[];
}
interface ChangeMeta {
  source?: "agent" | "merge" | "review";
  /** Positions are in the transaction's final document. */
  add?: AgentChange[];
  remove?: string[];
  clear?: boolean;
  focus?: FocusRange;
  releaseFocus?: string;
}
export interface ScratchDocumentStorage {
  noteId: string | null;
  title: string;
  session: number;
}

declare module "@tiptap/core" {
  interface Storage {
    scratchDocument: ScratchDocumentStorage;
  }
  interface Commands<ReturnType> {
    agentChanges: {
      acceptAgentChange: (id: string) => ReturnType;
      rejectAgentChange: (id: string) => ReturnType;
      acceptAllAgentChanges: () => ReturnType;
      rejectAllAgentChanges: () => ReturnType;
      scrollToAgentChange: (id: string) => ReturnType;
    };
  }
}

export const ScratchDocument = Extension.create<
  undefined,
  ScratchDocumentStorage
>({
  name: "scratchDocument",
  addStorage: () => ({ noteId: null, title: "", session: 0 }),
});
export const agentChangesKey = new PluginKey<ChangeState>("agentChanges");
export function setChangeMeta(tr: Transaction, meta: ChangeMeta): Transaction {
  return tr.setMeta(agentChangesKey, meta);
}

function touches(tr: Transaction, from: number, to: number): boolean {
  for (const [index, map] of tr.mapping.maps.entries()) {
    let touched = false;
    map.forEach((start, end) => {
      if (start <= to && end >= from) touched = true;
    });
    const step = tr.steps[index];
    // Mark and attribute steps change content without changing positions.
    if (
      "from" in step &&
      "to" in step &&
      typeof step.from === "number" &&
      typeof step.to === "number"
    ) {
      if (step.from <= to && step.to >= from) touched = true;
    } else if (
      "pos" in step &&
      typeof step.pos === "number" &&
      step.pos >= from &&
      step.pos <= to
    ) {
      touched = true;
    }
    if (touched) return true;
    from = map.map(from, 1);
    to = map.map(to, -1);
  }
  return false;
}

function reviewTransaction(
  tr: Transaction,
  hunks: AgentChange[],
  ids: string[],
  reject: boolean,
): void {
  if (reject) {
    closeHistory(tr);
    // Newest first also unwinds edits that overlap an earlier agent edit.
    for (const hunk of hunks
      .filter((item) => ids.includes(item.id))
      .reverse()) {
      tr.replace(
        tr.mapping.map(hunk.from, -1),
        tr.mapping.map(hunk.to, 1),
        hunk.oldSlice,
      );
    }
    setChangeMeta(tr, { source: "review", remove: ids });
    return;
  }
  setChangeMeta(tr, { remove: ids }).setMeta("addToHistory", false);
}

// Lucide "check" and "x", matching the stroke icons in components/icons.
const REVIEW_ICON_PATHS = {
  accept: "M20 6 9 17l-5-5",
  reject: "M18 6 6 18M6 6l12 12",
} as const;

function decorations(editor: Editor, state: ChangeState): DecorationSet {
  const { doc, schema } = editor.state;
  const result: Decoration[] = [];
  for (const hunk of state.hunks) {
    const { from, to } = hunk;
    if (from < to) {
      doc.nodesBetween(from, to, (node, pos) => {
        if (node.isBlock && pos >= from && pos + node.nodeSize <= to) {
          result.push(
            Decoration.node(pos, pos + node.nodeSize, {
              class: "agent-change-block",
            }),
          );
          return false;
        }
        if (node.isInline) {
          result.push(
            Decoration.inline(
              Math.max(pos, from),
              Math.min(pos + node.nodeSize, to),
              { class: "agent-change-insert" },
            ),
          );
        }
      });
    }
    if (hunk.oldSlice.size) {
      result.push(
        Decoration.widget(
          from,
          () => {
            const inline =
              hunk.oldSlice.content.firstChild?.isInline ||
              (hunk.oldSlice.content.childCount === 1 &&
                hunk.oldSlice.content.firstChild?.isTextblock &&
                hunk.oldSlice.openStart > 0 &&
                hunk.oldSlice.openEnd > 0);
            const deleted = document.createElement(inline ? "del" : "div");
            deleted.className = inline
              ? "agent-change-delete"
              : "agent-change-delete agent-change-deleted-block";
            deleted.contentEditable = "false";
            if (inline)
              deleted.textContent = hunk.oldSlice.content.textBetween(
                0,
                hunk.oldSlice.content.size,
                "\n",
              );
            else
              deleted.appendChild(
                DOMSerializer.fromSchema(schema).serializeFragment(
                  hunk.oldSlice.content,
                ),
              );
            return deleted;
          },
          { key: `${hunk.id}-deleted`, side: -1 },
        ),
      );
    }
    // Anchor controls at the end of the last textblock the hunk changes. A hunk
    // can end between blocks or at the very start of the next paragraph (an
    // inserted paragraph's minimal diff does), and a widget there would render
    // inside that untouched block.
    let controlsAt = to;
    if (from < to)
      doc.nodesBetween(from, to, (node, pos) => {
        if (node.isTextblock && pos + 1 < to)
          controlsAt = Math.min(to, pos + node.nodeSize - 1);
      });
    result.push(
      Decoration.widget(
        controlsAt,
        () => {
          const kind = hunk.origin === "external" ? "external" : "agent";
          const controls = document.createElement("span");
          controls.className = "agent-change-controls";
          controls.contentEditable = "false";
          controls.setAttribute("role", "group");
          controls.setAttribute(
            "aria-label",
            hunk.origin === "external" ? "External change" : "Agent change",
          );
          for (const [label, reject, path] of [
            ["Accept", false, REVIEW_ICON_PATHS.accept],
            ["Reject", true, REVIEW_ICON_PATHS.reject],
          ] as const) {
            const button = document.createElement("button");
            button.type = "button";
            button.title = `${label} ${kind} change`;
            button.setAttribute("aria-label", `${label} ${kind} change`);
            button.dataset.action = reject ? "reject" : "accept";
            button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
            button.onmousedown = (event) => event.preventDefault();
            button.onclick = () => {
              const tr = editor.state.tr;
              reviewTransaction(
                tr,
                agentChangesKey.getState(editor.state)?.hunks ?? [],
                [hunk.id],
                reject,
              );
              editor.view.dispatch(tr);
            };
            controls.appendChild(button);
          }
          return controls;
        },
        { key: `${hunk.id}-controls`, side: 1 },
      ),
    );
  }
  // The selection a run was sent with, so the note shows what the agent is working on.
  for (const range of state.focusRanges)
    if (range.from < range.to)
      result.push(
        Decoration.inline(range.from, range.to, { class: "agent-selection" }),
      );
  return DecorationSet.create(doc, result);
}

export function scrollPositionIntoView(editor: Editor, pos: number): void {
  const dom = editor.view.domAtPos(pos).node;
  (dom instanceof HTMLElement ? dom : dom.parentElement)?.scrollIntoView({
    block: "center",
    behavior: "smooth",
  });
}

/** The selection the current run was sent with, as it maps through later edits. */
export function activeFocusRange(editor: Editor): FocusRange | null {
  return agentChangesKey.getState(editor.state)?.focusRanges[0] ?? null;
}

/**
 * The selection attached to the agent panel. Selecting text attaches it; it
 * then stays attached, mapped through edits, when the user clicks elsewhere to
 * read or scroll, until they select something else, clear it, delete the text,
 * or send it with a message.
 */
interface AttachedSelection {
  range: { from: number; to: number } | null;
  /** The editor has focus, so the browser paints a live selection itself. */
  focused: boolean;
}
type AttachedMeta = { focused: boolean } | { clear: true };
const attachedSelectionKey = new PluginKey<AttachedSelection>("attachedSelection");
const attachedSelection = new Plugin<AttachedSelection>({
  key: attachedSelectionKey,
  state: {
    init: () => ({ range: null, focused: false }),
    apply(tr, previous, _, state) {
      const meta = tr.getMeta(attachedSelectionKey) as AttachedMeta | undefined;
      const focused = meta && "focused" in meta ? meta.focused : previous.focused;
      if (meta && "clear" in meta) return { range: null, focused };
      const { from, to, empty } = state.selection;
      let range = empty ? previous.range : { from, to };
      if (range && empty && tr.docChanged) {
        range = {
          from: tr.mapping.map(range.from, 1),
          to: tr.mapping.map(range.to, -1),
        };
        if (range.from >= range.to) range = null;
      }
      if (
        range === previous.range ||
        (range &&
          previous.range &&
          range.from === previous.range.from &&
          range.to === previous.range.to)
      )
        range = previous.range;
      return range === previous.range && focused === previous.focused
        ? previous
        : { range, focused };
    },
  },
  props: {
    decorations(state) {
      const { range, focused } = attachedSelectionKey.getState(state)!;
      // Not while the browser paints the live selection, nor during a run,
      // whose own highlight covers the selection it was sent with.
      if (
        !range ||
        (focused && !state.selection.empty) ||
        agentChangesKey.getState(state)?.focusRanges.length
      )
        return null;
      return DecorationSet.create(state.doc, [
        Decoration.inline(range.from, range.to, { class: "agent-selection" }),
      ]);
    },
    handleDOMEvents: {
      focus: (view) => {
        view.dispatch(
          view.state.tr.setMeta(attachedSelectionKey, { focused: true }),
        );
        return false;
      },
      blur: (view) => {
        view.dispatch(
          view.state.tr.setMeta(attachedSelectionKey, { focused: false }),
        );
        return false;
      },
    },
  },
});

export function attachedRange(editor: Editor) {
  return attachedSelectionKey.getState(editor.state)?.range ?? null;
}

/** Detaches the selection, collapsing a live one so it doesn't re-attach. */
export function detachSelection(editor: Editor): void {
  const { tr } = editor.state;
  if (!tr.selection.empty)
    tr.setSelection(TextSelection.create(tr.doc, tr.selection.to));
  editor.view.dispatch(
    tr.setMeta(attachedSelectionKey, { clear: true }).setMeta("addToHistory", false),
  );
}

export const AgentChanges = Extension.create({
  name: "agentChanges",
  addCommands() {
    const editor = this.editor;
    return {
      acceptAgentChange:
        (id) =>
        ({ tr, state, dispatch }) => {
          if (dispatch)
            reviewTransaction(
              tr,
              agentChangesKey.getState(state)?.hunks ?? [],
              [id],
              false,
            );
          return true;
        },
      rejectAgentChange:
        (id) =>
        ({ tr, state, dispatch }) => {
          if (dispatch)
            reviewTransaction(
              tr,
              agentChangesKey.getState(state)?.hunks ?? [],
              [id],
              true,
            );
          return true;
        },
      acceptAllAgentChanges:
        () =>
        ({ tr, state, dispatch }) => {
          const hunks = agentChangesKey.getState(state)?.hunks ?? [];
          if (dispatch)
            reviewTransaction(
              tr,
              hunks,
              hunks.map((h) => h.id),
              false,
            );
          return true;
        },
      rejectAllAgentChanges:
        () =>
        ({ tr, state, dispatch }) => {
          const hunks = agentChangesKey.getState(state)?.hunks ?? [];
          if (dispatch)
            reviewTransaction(
              tr,
              hunks,
              hunks.map((h) => h.id),
              true,
            );
          return true;
        },
      scrollToAgentChange: (id) => () => {
        const hunk = agentChangesKey
          .getState(editor.state)
          ?.hunks.find((h) => h.id === id);
        if (!hunk) return false;
        scrollPositionIntoView(editor, hunk.from);
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<ChangeState>({
        key: agentChangesKey,
        state: {
          init: () => ({ hunks: [], focusRanges: [] }),
          apply(tr, previous) {
            const meta = tr.getMeta(agentChangesKey) as ChangeMeta | undefined;
            if (meta?.clear) return { hunks: [], focusRanges: [] };
            if (!tr.docChanged && !meta) return previous;
            // Keep the same state object while nothing is tracked, so review UI
            // subscribed through useAgentChanges doesn't re-render on every keystroke.
            if (!meta && !previous.hunks.length && !previous.focusRanges.length)
              return previous;
            const hunks = previous.hunks
              .filter((hunk) => {
                if (meta?.remove?.includes(hunk.id)) return false;
                return (
                  !tr.docChanged ||
                  meta?.source === "agent" ||
                  meta?.source === "merge" ||
                  !touches(tr, hunk.from, hunk.to)
                );
              })
              .map((hunk) => ({
                ...hunk,
                from: tr.mapping.map(hunk.from, -1),
                to: tr.mapping.map(hunk.to, 1),
              }));
            if (meta?.add) hunks.push(...meta.add);
            const focusRanges = previous.focusRanges
              .filter((range) => range.id !== meta?.releaseFocus)
              .map((range) => ({
                ...range,
                from: tr.mapping.map(range.from, -1),
                to: tr.mapping.map(range.to, 1),
              }));
            if (meta?.focus) focusRanges.push(meta.focus);
            return { hunks, focusRanges };
          },
        },
        props: {
          decorations: (state) =>
            decorations(editor, agentChangesKey.getState(state)!),
        },
      }),
      attachedSelection,
    ];
  },
});

const emptyChanges: AgentChangeSummary[] = [];
export function useAgentChanges(editor: Editor | null): AgentChangeSummary[] {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!editor) return () => {};
      editor.on("transaction", notify);
      return () => {
        editor.off("transaction", notify);
      };
    },
    [editor],
  );
  const snapshot = useCallback(
    () =>
      editor
        ? (agentChangesKey.getState(editor.state)?.hunks ?? emptyChanges)
        : emptyChanges,
    [editor],
  );
  return useSyncExternalStore(subscribe, snapshot, () => emptyChanges);
}
