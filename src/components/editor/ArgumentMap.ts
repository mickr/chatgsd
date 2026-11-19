import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * A note passage the reasoning ran through. index is its place in the whole
 * trace, number its place among the steps you can see in the note; via names
 * the ledger steps (web, service, you, note, edit) between the previous
 * passage and this one that have no place in the note.
 */
export interface ArgumentMapStep { from: number; to: number; sure: boolean; index: number; number: number; via: string[] }
/** The passages an offer's reasoning ran through, ending at the passage it decided on. */
export interface ArgumentMapState {
  steps: ArgumentMapStep[];
  /** The passage the offer is about. In an outcome trace, block is the whole highlight it sits in. */
  decision: { from: number; to: number; via: string[]; block?: { from: number; to: number } };
  /** The step being read: a trace index, or the trace's length for the decision. */
  active: number | null;
  /** The trace's length, which is the decision's index. */
  length: number;
}

type Range = { from: number; to: number };
/** The map of a prepared offer: its note passages in order, with the ledger steps between them. */
export function argumentMapFor(prepared: { trace: (Range | null)[]; source: Range; provenance: ({ kind: string } | null)[];
  offer: { trace: { sure: boolean }[] }; outcome?: Range }, active: number | null): ArgumentMapState {
  const steps: ArgumentMapStep[] = [];
  let via: string[] = [];
  prepared.trace.forEach((range, index) => {
    if (!range) { via.push(prepared.provenance[index]?.kind ?? "note"); return; }
    steps.push({ ...range, sure: prepared.offer.trace[index]?.sure ?? true, index, number: steps.length + 1, via });
    via = [];
  });
  const block = prepared.outcome && { from: prepared.outcome.from, to: prepared.outcome.to };
  return { steps, decision: { ...prepared.source, via, ...(block ? { block } : {}) }, active, length: prepared.trace.length };
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
          return { ...previous, decision,
            steps: previous.steps.map(step => mapRange(step, map)).filter((step): step is ArgumentMapStep => !!step) };
        },
      },
      props: {
        decorations(state) {
          const map = argumentMapKey.getState(state);
          if (!map) return null;
          const decorations = map.steps.map(step => Decoration.inline(step.from, step.to, {
            class: `argument-map-step${map.active === step.index ? " argument-map-active" : ""}`,
            "data-step": String(step.number),
            ...(step.sure ? {} : { "data-unsure": "true" }),
          }));
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
