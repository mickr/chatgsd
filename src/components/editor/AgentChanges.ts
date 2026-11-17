import { Extension, type Editor } from "@tiptap/core";
import { DOMSerializer, type Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import { useCallback, useSyncExternalStore } from "react";
import { changeMarker, destroyChangeMarker, type AgentLineChange } from "./AgentChangeMarker";

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
  dismissed?: boolean;
}
interface ChangeState {
  hunks: AgentChange[];
  focusRanges: FocusRange[];
  presence: Record<string, { from: number; to: number }>;
  arrival: DecorationSet;
  lineChanges: AgentLineChange[];
}
interface ChangeMeta {
  source?: "agent" | "merge" | "review";
  add?: AgentChange[];
  remove?: string[];
  clear?: boolean;
  focus?: FocusRange;
  releaseFocus?: string;
  dismissSelection?: boolean;
  /** Agent presence metadata - keys are runIds, values are ranges */
  presence?: { [runId: string]: { from: number; to: number } };
  /** Clear presence for a specific runId */
  clearPresence?: string;
  arrival?: Array<{ from: number; to: number }>;
  clearArrival?: boolean;
  lineChanges?: AgentLineChange[];
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

/** Brief word-by-word reveal of committed text, without changing document marks. */
function arrivalDecorations(doc: ProseMirrorNode, ranges: Array<{ from: number; to: number }>): DecorationSet {
  const result: Decoration[] = [];
  for (const { from, to } of ranges) {
    doc.nodesBetween(from, to, (node, pos) => {
      if (result.length >= 40) return false;
      if (!node.isText || !node.text) return;
      const end = Math.min(to - pos, node.nodeSize);
      const words = /\S+\s*/gu;
      words.lastIndex = Math.max(0, from - pos);
      let match: RegExpExecArray | null;
      while (result.length < 40 && (match = words.exec(node.text)) && match.index < end) {
        result.push(Decoration.inline(pos + match.index, pos + Math.min(words.lastIndex, end), {
          class: "agent-text-arrival",
          style: `animation-delay: ${Math.min(result.length * 12, 120)}ms`,
        }));
      }
    });
  }
  return result.length ? DecorationSet.create(doc, result) : DecorationSet.empty;
}

function decorations(editor: Editor, state: ChangeState): DecorationSet {
  const { doc, schema } = editor.state;
  const result: Decoration[] = state.arrival.find();
  const markerGroups = new Map<number, AgentLineChange[]>();
  for (const change of state.lineChanges) {
    const position = doc.resolve(change.from);
    // Nested blocks may establish positioning or clipping (notably table cells).
    // Put their marker before the outer block, in the editor's own gutter.
    const anchor = position.depth > 1 ? position.before(1) : change.from;
    const group = markerGroups.get(anchor);
    if (group) group.push(change);
    else markerGroups.set(anchor, [change]);
  }
  for (const [anchor, changes] of markerGroups)
    result.push(Decoration.widget(anchor, () => changeMarker(changes), {
      key: changes.map((change) => change.id).join(":"),
      side: -1,
      stopEvent: () => true,
      ignoreSelection: true,
      destroy: destroyChangeMarker,
    }));
  
  // Render hunks first (existing tracked changes) - only external origin for merge review
  for (const hunk of state.hunks) {
    if (hunk.origin !== "external") continue;
    
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
          const controls = document.createElement("span");
          controls.className = "agent-change-controls";
          controls.contentEditable = "false";
          controls.setAttribute("role", "group");
          controls.setAttribute("aria-label", "External change");
          for (const [label, reject, path] of [
            ["Accept", false, REVIEW_ICON_PATHS.accept],
            ["Reject", true, REVIEW_ICON_PATHS.reject],
          ] as const) {
            const button = document.createElement("button");
            button.type = "button";
            button.title = `${label} external change`;
            button.setAttribute("aria-label", `${label} external change`);
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
  
  // Render focus ranges (the selection a run was sent with)
  for (const range of state.focusRanges)
    if (!range.dismissed && range.from < range.to)
      result.push(
        Decoration.inline(range.from, range.to, { class: "agent-selection" }),
      );
  
  // Render single agent presence caret (not accumulating per-run carets)
  const agentPresence = state.presence["agent"];
  if (agentPresence) {
    const { from, to } = agentPresence;
    if (from < to)
      result.push(Decoration.inline(from, to, { class: "agent-working-range" }));
    result.push(Decoration.widget(to, () => {
      const caret = document.createElement("span");
      caret.className = "agent-presence-caret";
      caret.dataset.writing = String(state.arrival !== DecorationSet.empty);
      caret.contentEditable = "false";
      caret.setAttribute("aria-label", "Agent working here");
      const label = document.createElement("span");
      label.className = "agent-presence-label";
      label.textContent = "Agent";
      caret.append(label);
      return caret;
    }, { key: state.arrival === DecorationSet.empty ? "agent-presence-idle" : "agent-presence-writing", side: -1 }));
  }
  
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
 * The selection attached to the agent panel. Moving focus to the composer keeps
 * it attached and mapped through edits. Collapsing the editor selection or
 * pressing Escape dismisses it.
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
      let range = tr.selectionSet
        ? empty ? null : { from, to }
        : previous.range;
      if (range && !tr.selectionSet && tr.docChanged) {
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
        agentChangesKey.getState(state)?.focusRanges.some((range) => !range.dismissed)
      )
        return null;
      return DecorationSet.create(state.doc, [
        Decoration.inline(range.from, range.to, { class: "agent-selection" }),
      ]);
    },
    handleKeyDown: (view, event) => {
      const changes = agentChangesKey.getState(view.state);
      const presence = changes?.presence.agent;
      if (event.key !== "Escape" || !(
        attachedSelectionKey.getState(view.state)?.range ||
        changes?.focusRanges.some((range) => !range.dismissed) ||
        (presence && presence.from < presence.to)
      )) return false;
      event.stopPropagation();
      const { tr } = view.state;
      tr.setSelection(TextSelection.create(tr.doc, tr.selection.to));
      view.dispatch(
        setChangeMeta(tr, { dismissSelection: true })
          .setMeta(attachedSelectionKey, { clear: true }).setMeta("addToHistory", false),
      );
      return true;
    },
    handleDOMEvents: {
      mousedown: (view, event) => {
        if (event.button === 0)
          view.dispatch(setChangeMeta(view.state.tr, { dismissSelection: true })
            .setMeta("addToHistory", false));
        return false;
      },
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
    setChangeMeta(tr, { dismissSelection: true })
      .setMeta(attachedSelectionKey, { clear: true }).setMeta("addToHistory", false),
  );
}

/** Clear the agent presence (single session-level caret) */
export function clearAgentPresence(editor: Editor): void {
  editor.view.dispatch(
    setChangeMeta(editor.state.tr, {
      clearPresence: "agent",
    }).setMeta("addToHistory", false),
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
          init: () => ({ hunks: [], focusRanges: [], presence: {}, arrival: DecorationSet.empty, lineChanges: [] }),
          apply(tr, previous) {
            const meta = tr.getMeta(agentChangesKey) as ChangeMeta | undefined;
            if (meta?.clear) return { hunks: [], focusRanges: [], presence: {}, arrival: DecorationSet.empty, lineChanges: [] };
            // Dismiss the paint, not the run's mapped target, when the user
            // resumes editing. Agent transactions must not count as user input.
            const dismissSelection = meta?.dismissSelection ||
              (!meta?.source && (tr.selectionSet || tr.docChanged));
            if (!tr.docChanged && !meta && !dismissSelection) return previous;
            // Keep the same state object while nothing is tracked, so review UI
            // subscribed through useAgentChanges doesn't re-render on every keystroke.
            if (!meta && !previous.hunks.length && !previous.lineChanges.length && !previous.focusRanges.length && !Object.keys(previous.presence).length && previous.arrival === DecorationSet.empty)
              return previous;
            
            // Only external disk changes retain review hunks.
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
            if (meta?.add) hunks.push(...meta.add.filter((hunk) => hunk.origin === "external"));
            
            // Update focus ranges
            const focusRanges: FocusRange[] = previous.focusRanges
              .filter((range) => range.id !== meta?.releaseFocus)
              .map((range) => ({
                ...range,
                from: tr.mapping.map(range.from, -1),
                dismissed: range.dismissed || dismissSelection,
                to: tr.mapping.map(range.to, 1),
              }));
            if (meta?.focus) focusRanges.push(meta.focus);
            
            const presence: ChangeState["presence"] = {};
            const previousPresence = previous.presence.agent;
            if (previousPresence && meta?.clearPresence !== "agent") {
              if (previousPresence.from === previousPresence.to) {
                const pos = tr.mapping.map(previousPresence.to, 1);
                presence.agent = { from: pos, to: pos };
              } else {
                const from = tr.mapping.map(previousPresence.from, 1);
                const to = tr.mapping.map(previousPresence.to, -1);
                if (from < to) presence.agent = { from, to };
              }
            }
            if (meta?.presence?.agent) presence.agent = meta.presence.agent;
            if (dismissSelection && presence.agent)
              presence.agent = { from: presence.agent.to, to: presence.agent.to };
            
            let arrival = meta?.clearArrival || tr.docChanged ? DecorationSet.empty : previous.arrival;
            if (meta?.arrival) arrival = arrivalDecorations(tr.doc, meta.arrival);
            // Markers describe the latest editing turn, and disappear if their
            // passage changes again. The immutable transcript keeps older edits.
            let lineChanges = previous.lineChanges
              .filter((change) => !tr.docChanged || !touches(tr, change.from, change.to))
              .map((change) => ({
                ...change,
                from: tr.mapping.map(change.from, -1),
                to: tr.mapping.map(change.to, 1),
              }));
            if (meta?.lineChanges?.length) {
              if (previous.lineChanges[0]?.runId !== meta.lineChanges[0].runId) lineChanges = [];
              for (const change of meta.lineChanges) {
                const earlier = previous.lineChanges.find((item) =>
                  item.runId === change.runId &&
                  tr.mapping.map(item.from, -1) === change.from &&
                  tr.mapping.map(item.to, 1) === change.to);
                lineChanges.push(earlier ? { ...change, before: earlier.before } : change);
              }
            }
            return { hunks, focusRanges, presence, arrival, lineChanges };
          },
        },
        view(view) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let previous = DecorationSet.empty;
          const update = () => {
            const arrival = agentChangesKey.getState(view.state)!.arrival;
            if (arrival === previous) return;
            previous = arrival;
            clearTimeout(timer);
            if (arrival !== DecorationSet.empty)
              timer = setTimeout(() => {
                view.dispatch(setChangeMeta(view.state.tr, { clearArrival: true }).setMeta("addToHistory", false));
              }, 420);
          };
          update();
          return { update, destroy: () => clearTimeout(timer) };
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
  const snapshot = useCallback(() => {
    const hunks = editor && agentChangesKey.getState(editor.state)?.hunks;
    return hunks?.length ? hunks : emptyChanges;
  }, [editor]);
  return useSyncExternalStore(subscribe, snapshot, () => emptyChanges);
}
