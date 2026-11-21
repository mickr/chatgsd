import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { stepTargetIndex, traceActivePath, type TraceRole } from "../../lib/agent/writingOffers";

/**
 * A note passage the reasoning ran through. index is its place in the whole
 * trace, and index + 1 is the number it carries everywhere; via names the steps
 * with no place in the note (web, service, you, chat, note, edit, or removed
 * for a passage since cut) leading into it.
 */
export interface ArgumentMapStep {
  from: number;
  to: number;
  sure: boolean;
  index: number;
  via: string[];
  role?: TraceRole;
}

/** One directed connection in the margin map, either between two note passages or from an off-page root. */
export interface ArgumentMapEdge {
  /** Source visible step's trace index, or null when the branch begins outside the note. */
  from: number | null;
  /** Target visible step's trace index, or `length` for the outcome diamond. */
  to: number;
  /** The kind of each step passed through outside the note, in order: the steps after the source, or all of them from an off-page root. */
  via: string[];
  unsure: boolean;
  role: TraceRole;
  /** Trace step indices traversed along this connection, for active/branch highlighting. */
  steps: number[];
}

/** The passages an offer's reasoning ran through, converging on the passage it decided on. */
export interface ArgumentMapState {
  steps: ArgumentMapStep[];
  /** Directed connections across converging branches; omitted in legacy linear fixtures. */
  edges?: ArgumentMapEdge[];
  /** Trace indices (and `length` for the outcome) on the focused step's branch. */
  branch?: number[];
  /** The passage the offer is about. In an outcome trace, block is the whole highlight it sits in. */
  decision: { from: number; to: number; via: string[]; block?: { from: number; to: number } };
  /** The step being read: a trace index, or the trace's length for the decision. */
  active: number | null;
  /** The trace's length, which is the decision's index. */
  length: number;
}

type Range = { from: number; to: number };
/** The map of a prepared offer: its note passages, converging branches, and the ledger steps along each. */
export function argumentMapFor(prepared: {
  trace: (Range | null)[];
  source: Range;
  provenance: ({ kind: string } | null)[];
  offer: { trace: { sure: boolean; leads_to?: number | null; role?: TraceRole }[] };
  outcome?: Range;
}, active: number | null): ArgumentMapState {
  const rawTrace = prepared.offer.trace;
  const n = prepared.trace.length;
  const inDegree = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) inDegree[stepTargetIndex(rawTrace, i)]++;

  const edges: ArgumentMapEdge[] = [];
  const seenOffPage = new Set<number>();
  // A step with neither a place in the note nor a ledger entry is a passage the writer has since cut.
  const offPageKind = (index: number) => prepared.provenance[index]?.kind ?? "removed";

  // Walk from every visible note step to the next visible note step (or outcome) on its branch.
  for (let i = 0; i < n; i++) {
    if (!prepared.trace[i]) continue;
    const stepMeta = rawTrace[i];
    const via: string[] = [];
    const edgeSteps = [i];
    let unsure = !(stepMeta?.sure ?? true);
    let tensions = stepMeta?.role === "tensions";
    let curr = stepTargetIndex(rawTrace, i);
    for (let hops = 0; hops <= n && curr < n && !prepared.trace[curr]; hops++) {
      seenOffPage.add(curr);
      edgeSteps.push(curr);
      via.push(offPageKind(curr));
      if (rawTrace[curr]?.sure === false) unsure = true;
      if (rawTrace[curr]?.role === "tensions") tensions = true;
      curr = stepTargetIndex(rawTrace, curr);
    }
    edges.push({ from: i, to: curr, via, unsure, role: tensions ? "tensions" : "supports", steps: edgeSteps });
  }

  // Walk any branch that starts off-page (no preceding note passage) into its first visible target or outcome.
  for (let i = 0; i < n; i++) {
    if (prepared.trace[i] || inDegree[i] > 0 || seenOffPage.has(i)) continue;
    const via: string[] = [];
    const edgeSteps: number[] = [];
    let unsure = false;
    let tensions = false;
    let curr = i;
    for (let hops = 0; hops <= n && curr < n && !prepared.trace[curr]; hops++) {
      const already = seenOffPage.has(curr);
      seenOffPage.add(curr);
      edgeSteps.push(curr);
      via.push(offPageKind(curr));
      if (rawTrace[curr]?.sure === false) unsure = true;
      if (rawTrace[curr]?.role === "tensions") tensions = true;
      curr = stepTargetIndex(rawTrace, curr);
      if (already) break;
    }
    if (prepared.trace[curr] || curr === n)
      edges.push({ from: null, to: curr, via, unsure, role: tensions ? "tensions" : "supports", steps: edgeSteps });
  }

  const incomingVia = (targetIndex: number) =>
    edges.filter(edge => edge.to === targetIndex).flatMap(edge => edge.via);

  const steps: ArgumentMapStep[] = [];
  prepared.trace.forEach((range, index) => {
    if (!range) return;
    const role = rawTrace[index]?.role;
    steps.push({
      ...range,
      sure: rawTrace[index]?.sure ?? true,
      index,
      via: incomingVia(index),
      ...(role === "tensions" ? { role } : {}),
    });
  });

  const branch = [...traceActivePath(rawTrace, active)];
  const block = prepared.outcome && { from: prepared.outcome.from, to: prepared.outcome.to };
  return {
    steps,
    edges,
    branch,
    decision: { ...prepared.source, via: incomingVia(n), ...(block ? { block } : {}) },
    active,
    length: n,
  };
}

const argumentMapKey = new PluginKey<ArgumentMapState | null>("argumentMap");

function mapRange<T extends { from: number; to: number }>(range: T, map: (pos: number, bias: number) => number): T | null {
  const from = map(range.from, 1);
  const to = map(range.to, -1);
  return from < to ? { ...range, from, to } : null;
}

/** Highlights the map's passages in the note. Purely visual: it never changes the document. */
export const ArgumentMap = Extension.create({
  name: "argumentMap",
  addProseMirrorPlugins() {
    return [new Plugin<ArgumentMapState | null>({
      key: argumentMapKey,
      state: {
        init: () => null,
        apply(tr, previous) {
          const meta = tr.getMeta(argumentMapKey) as { map: ArgumentMapState | null } | undefined;
          if (meta) return meta.map;
          if (!previous || !tr.docChanged) return previous;
          const map = tr.mapping.map.bind(tr.mapping);
          const decision = mapRange(previous.decision, map);
          if (!decision) return null;
          const block = decision.block && mapRange(decision.block, map);
          if (block) decision.block = block; else delete decision.block;
          const steps = previous.steps.map(step => mapRange(step, map)).filter((step): step is ArgumentMapStep => !!step);
          const surviving = new Set(steps.map(step => step.index));
          surviving.add(previous.length);
          const edges = previous.edges?.filter(edge =>
            (edge.from === null || surviving.has(edge.from)) && surviving.has(edge.to));
          return { ...previous, decision, steps, ...(edges ? { edges } : {}) };
        },
      },
      props: {
        decorations(state) {
          const map = argumentMapKey.getState(state);
          if (!map) return null;
          const branchSet = new Set(map.branch ?? []);
          const decorations = map.steps.map(step => {
            const isActive = map.active === step.index;
            const onBranch = !isActive && branchSet.has(step.index);
            return Decoration.inline(step.from, step.to, {
              class: `argument-map-step${isActive ? " argument-map-active" : onBranch ? " argument-map-branch" : ""}`,
              "data-step": String(step.index + 1),
              ...(step.sure ? {} : { "data-unsure": "true" }),
              ...(step.role === "tensions" ? { "data-role": "tensions" } : {}),
            });
          });
          const outcomeActive = map.active === map.length;
          const { block } = map.decision;
          // The whole highlight reads as one outcome; only the sentence the question is about is marked within it.
          if (block) decorations.unshift(Decoration.inline(block.from, block.to, {
            class: `argument-map-outcome${outcomeActive ? " argument-map-outcome-active" : ""}`,
          }));
          decorations.push(Decoration.inline(map.decision.from, map.decision.to, {
            class: `${block ? "argument-map-focus" : "argument-map-decision"}${outcomeActive ? " argument-map-active" : ""}`,
          }));
          return DecorationSet.create(state.doc, decorations);
        },
      },
    }), offerPassage];
  },
});

/**
 * The passage the open offer card is about, tinted while the writer looks at the
 * card, and flashed when they jump to it, so the card and the note stay connected.
 */
interface OfferPassage { from: number; to: number; flash: number }
const offerPassageKey = new PluginKey<OfferPassage | null>("offerPassage");
const offerPassage = new Plugin<OfferPassage | null>({
  key: offerPassageKey,
  state: {
    init: () => null,
    apply(tr, previous) {
      const meta = tr.getMeta(offerPassageKey) as { passage: OfferPassage | null } | undefined;
      if (meta) return meta.passage;
      if (!previous || !tr.docChanged) return previous;
      return mapRange(previous, tr.mapping.map.bind(tr.mapping));
    },
  },
  props: {
    decorations(state) {
      const passage = offerPassageKey.getState(state);
      if (!passage) return null;
      // The flash count is part of the attributes, so each jump redraws the element and restarts its animation.
      return DecorationSet.create(state.doc, [Decoration.inline(passage.from, passage.to, passage.flash
        ? { class: "agent-offer-passage agent-offer-passage-flash", "data-flash": String(passage.flash) }
        : { class: "agent-offer-passage" })]);
    },
  },
});

let flashes = 0;
/** Tint the offer's passage, flash it once, or clear it. */
export function setOfferPassage(editor: Editor, range: { from: number; to: number } | null, flash = false): void {
  if (editor.isDestroyed) return;
  const size = editor.state.doc.content.size;
  const passage = range && range.from >= 0 && range.to <= size && range.from < range.to
    ? { from: range.from, to: range.to, flash: flash ? ++flashes : 0 } : null;
  editor.view.dispatch(editor.state.tr.setMeta(offerPassageKey, { passage }).setMeta("addToHistory", false));
}

export function offerPassageState(editor: Editor): OfferPassage | null {
  return offerPassageKey.getState(editor.state) ?? null;
}

export function setArgumentMap(editor: Editor, map: ArgumentMapState | null): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(argumentMapKey, { map }).setMeta("addToHistory", false));
}

export function argumentMapState(editor: Editor): ArgumentMapState | null {
  return argumentMapKey.getState(editor.state) ?? null;
}
