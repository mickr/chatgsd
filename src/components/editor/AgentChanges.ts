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
interface TextArrival {
  ranges: Array<{ from: number; to: number }>;
  positions: number[];
  revealed: number;
}
interface ChangeState {
  hunks: AgentChange[];
  focusRanges: FocusRange[];
  presence: Record<string, { from: number; to: number }>;
  /** Counts the agent's moves, so the idle caret's fade restarts with each one. */
  presenceMoves: number;
  arrival: TextArrival | null;
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
  reveal?: number;
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

/** Animate only the view: saved content and undo history already contain the full edit. */
function textArrival(doc: ProseMirrorNode, ranges: Array<{ from: number; to: number }>): TextArrival | null {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || typeof Intl.Segmenter !== "function") return null;
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  const textRanges: TextArrival["ranges"] = [];
  const positions: number[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { from, to } of merged) {
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText || !node.text) return;
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      if (start >= end) return;
      // A minimal diff can start inside an emoji or combining sequence.
      const segments = segmenter.segment(node.text);
      const first = segments.containing(start - pos)!;
      const last = segments.containing(end - pos - 1)!;
      const range = { from: pos + first.index, to: pos + last.index + last.segment.length };
      const previous = textRanges[textRanges.length - 1];
      if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
      else textRanges.push(range);
      for (const { index, segment } of segmenter.segment(node.text.slice(range.from - pos, range.to - pos))) {
        const next = range.from + index + segment.length;
        if (!positions.length || next > positions[positions.length - 1]) positions.push(next);
      }
    });
  }
  return positions.length ? { ranges: textRanges, positions, revealed: 0 } : null;
}

/** How long the agent's caret stays after its last move. The CSS fade ends just before. */
const PRESENCE_REST_MS = 10_500;

function arrivalCaret(arrival: TextArrival): number {
  return arrival.revealed ? arrival.positions[arrival.revealed - 1] : arrival.ranges[0].from;
}

function decorations(editor: Editor, state: ChangeState): DecorationSet {
  const { doc, schema } = editor.state;
  const result: Decoration[] = [];
  if (state.arrival) {
    const cursor = arrivalCaret(state.arrival);
    for (const range of state.arrival.ranges) {
      const from = Math.max(range.from, cursor);
      if (from < range.to)
        result.push(Decoration.inline(from, range.to, { class: "agent-text-pending" }));
    }
  }
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
    result.push(Decoration.widget(state.arrival ? arrivalCaret(state.arrival) : to, () => {
      const caret = document.createElement("span");
      caret.className = "agent-presence-caret";
      caret.dataset.writing = String(Boolean(state.arrival));
      caret.contentEditable = "false";
      caret.setAttribute("aria-label", "Agent working here");
      const label = document.createElement("span");
      label.className = "agent-presence-label";
      label.textContent = "Agent";
      caret.append(label);
      return caret;
    }, { key: state.arrival ? "agent-presence-writing" : `agent-presence-idle-${state.presenceMoves}`, side: -1 }));
  }
  
  return DecorationSet.create(doc, result);
}

export function scrollPositionIntoView(editor: Editor, pos: number, behavior: ScrollBehavior = "smooth"): void {
  const dom = editor.view.domAtPos(pos).node;
  (dom instanceof HTMLElement ? dom : dom.parentElement)?.scrollIntoView({
    block: "center",
    behavior,
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
          init: () => ({ hunks: [], focusRanges: [], presence: {}, presenceMoves: 0, arrival: null, lineChanges: [] }),
          apply(tr, previous) {
            const meta = tr.getMeta(agentChangesKey) as ChangeMeta | undefined;
            if (meta?.clear) return { hunks: [], focusRanges: [], presence: {}, presenceMoves: 0, arrival: null, lineChanges: [] };
            if (meta?.reveal !== undefined && previous.arrival) {
              const arrival = meta.reveal >= previous.arrival.positions.length
                ? null : { ...previous.arrival, revealed: meta.reveal };
              return { ...previous, arrival };
            }
            // Dismiss the paint, not the run's mapped target, when the user
            // resumes editing. Agent transactions must not count as user input.
            const dismissSelection = meta?.dismissSelection ||
              (!meta?.source && (tr.selectionSet || tr.docChanged));
            if (!tr.docChanged && !meta && !dismissSelection) return previous;
            // Keep the same state object while nothing is tracked, so review UI
            // subscribed through useAgentChanges doesn't re-render on every keystroke.
            if (!meta && !previous.hunks.length && !previous.lineChanges.length && !previous.focusRanges.length && !Object.keys(previous.presence).length && !previous.arrival)
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
            const presenceMoves = previous.presenceMoves + (meta?.presence?.agent ? 1 : 0);
            if (presence.agent && (dismissSelection || focusRanges.some(range => range.dismissed)))
              presence.agent = { from: presence.agent.to, to: presence.agent.to };
            
            let arrival = meta?.clearArrival || meta?.clearPresence || dismissSelection || tr.docChanged
              ? null : previous.arrival;
            if (meta?.arrival) arrival = textArrival(tr.doc, meta.arrival);
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
            return { hunks, focusRanges, presence, presenceMoves, arrival, lineChanges };
          },
        },
        view(view) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let positions: number[] | undefined;
          let startedAt = 0;
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          let presenceMoves = -1;
          const rest = () => {
            const changes = agentChangesKey.getState(view.state)!;
            if (changes.presenceMoves === presenceMoves) return;
            presenceMoves = changes.presenceMoves;
            clearTimeout(idleTimer);
            if (!changes.presence.agent) return;
            idleTimer = setTimeout(() => {
              if (agentChangesKey.getState(view.state)?.presence.agent)
                view.dispatch(setChangeMeta(view.state.tr, { clearPresence: "agent" }).setMeta("addToHistory", false));
            }, PRESENCE_REST_MS);
          };
          const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
          const finish = () => {
            if (agentChangesKey.getState(view.state)?.arrival)
              view.dispatch(setChangeMeta(view.state.tr, { clearArrival: true }).setMeta("addToHistory", false));
          };
          const update = () => {
            rest();
            const arrival = agentChangesKey.getState(view.state)!.arrival;
            clearTimeout(timer);
            if (!arrival) { positions = undefined; return; }
            if (arrival.positions !== positions) {
              positions = arrival.positions;
              startedAt = performance.now();
            }
            timer = setTimeout(() => {
              const duration = Math.min(1000, arrival.positions.length * 6);
              const reveal = Math.floor((performance.now() - startedAt) / duration * arrival.positions.length);
              view.dispatch(setChangeMeta(view.state.tr, { reveal }).setMeta("addToHistory", false));
            }, 16);
          };
          const onMotion = () => { if (motion?.matches) finish(); };
          const onVisibility = () => { if (document.hidden) finish(); };
          // The companion, sidebar and toolbar handle their own clicks and Escape.
          // Clear only the agent's paint before those controls handle the event.
          const dismissOutsideEditor = (event: MouseEvent | KeyboardEvent) => {
            if (event instanceof KeyboardEvent ? event.key !== "Escape" : event.button !== 0) return;
            if (event.target instanceof Node && view.dom.contains(event.target)) return;
            const changes = agentChangesKey.getState(view.state)!;
            const range = changes.presence.agent;
            if (!changes.focusRanges.some(focus => !focus.dismissed) && !(range && range.from < range.to)) return;
            view.dispatch(setChangeMeta(view.state.tr, { dismissSelection: true }).setMeta("addToHistory", false));
          };
          const owner = view.dom.ownerDocument;
          owner.addEventListener("click", dismissOutsideEditor, true);
          owner.addEventListener("keydown", dismissOutsideEditor, true);
          motion?.addEventListener("change", onMotion);
          document.addEventListener("visibilitychange", onVisibility);
          update();
          return { update, destroy: () => {
            clearTimeout(timer);
            clearTimeout(idleTimer);
            owner.removeEventListener("click", dismissOutsideEditor, true);
            owner.removeEventListener("keydown", dismissOutsideEditor, true);
            motion?.removeEventListener("change", onMotion);
            document.removeEventListener("visibilitychange", onVisibility);
          } };
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
