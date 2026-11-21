import type { Spec } from "@json-render/core";
import type { ProvenanceEntry } from "../provenance";
import { traceBranches, type WritingTraceStep } from "../writingOffers";
import { traceViewTypes } from "./catalog";
import { renderableSpec } from "./content";

interface SpecElement {
  type: string;
  props: Record<string, unknown>;
  children: string[];
}

export interface TraceSpecInput {
  offerId?: string | null;
  trace: readonly WritingTraceStep[];
  provenance: readonly (ProvenanceEntry | null)[];
  view?: Spec | null;
  activeBranchSteps?: ReadonlySet<number> | null;
}

const SOURCE_BRANCH: Record<ProvenanceEntry["kind"], string> = {
  you: "From conversation",
  chat: "From discussion",
  web: "Web evidence",
  service: "Connected service",
  note: "Related note",
  edit: "Earlier edit",
  trace: "Earlier map",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and namespaces an agent-authored trace view spec, appending any
 * grounded TraceStep or TraceOutcome the layout left out so nothing is hidden.
 */
function customViewSpec(candidate: unknown, traceLength: number, offerId: string | null): Spec | null {
  const spec = renderableSpec(isRecord(candidate) ? { state: {}, ...candidate } : null);
  if (!spec || !traceLength) return null;
  const entries = Object.entries(spec.elements);
  if (entries.length > 64 || entries.some(([, el]) => !traceViewTypes.has(el.type))) return null;

  const seenSteps = new Set<number>();
  let hasOutcome = false;
  const elements: Record<string, SpecElement> = {};

  for (const [id, element] of entries) {
    const props = { ...element.props };
    if (element.type === "TraceStep") {
      const step = props.step;
      if (typeof step !== "number" || !Number.isInteger(step) || step < 1 || step > traceLength) return null;
      seenSteps.add(step);
      props.offerId = offerId;
    } else if (element.type === "TraceOutcome") {
      hasOutcome = true;
      props.offerId = offerId;
    }
    elements[`view/${id}`] = {
      type: element.type,
      props,
      children: (element.children ?? []).map(child => `view/${child}`),
    };
  }

  const rootId = `view/${spec.root}`;
  const extras: string[] = [];
  for (let step = 1; step <= traceLength; step++) {
    if (seenSteps.has(step)) continue;
    const id = `auto/step-${step}`;
    elements[id] = { type: "TraceStep", props: { offerId, step }, children: [] };
    extras.push(id);
  }
  if (!hasOutcome) {
    elements["auto/outcome"] = { type: "TraceOutcome", props: { offerId }, children: [] };
    extras.push("auto/outcome");
  }
  if (!extras.length) return { root: rootId, elements, state: {} } as Spec;
  elements["auto/root"] = {
    type: "Stack",
    props: { direction: "vertical", gap: "sm" },
    children: [rootId, ...extras],
  };
  return { root: "auto/root", elements, state: {} } as Spec;
}

/**
 * Builds a dynamic `@json-render` Spec for a convergent argument map: grouping
 * parallel premise threads, conversation/research branches, synthesis merges,
 * and tensions into structured cards converging on TraceOutcome.
 */
export function argumentMapSpec(input: TraceSpecInput): Spec {
  const { trace, provenance, view, activeBranchSteps } = input;
  const offerId = input.offerId ?? null;
  if (view && !activeBranchSteps) {
    const custom = customViewSpec(view, trace.length, offerId);
    if (custom) return custom;
  }

  const allSegments = traceBranches(trace);
  const segments = activeBranchSteps
    ? allSegments.filter(segment => segment.steps.some(step => activeBranchSteps.has(step)))
    : allSegments;

  const elements: Record<string, SpecElement> = {};
  const children: string[] = [];
  let premiseBranch = 0;

  segments.forEach((segment, segIdx) => {
    const stepIds = segment.steps.map(stepIndex => {
      const id = `step/${stepIndex + 1}`;
      elements[id] = { type: "TraceStep", props: { offerId, step: stepIndex + 1 }, children: [] };
      return id;
    });

    if (allSegments.length <= 1 && !segment.tensions) {
      children.push(...stepIds);
      return;
    }

    const targetLabel = segment.mergesInto < trace.length ? `→ Step ${segment.mergesInto + 1}` : "→ Outcome";
    const firstSource = provenance[segment.steps[0]];
    const label = segment.synthesis
      ? `Synthesis ${targetLabel}`
      : segment.tensions
        ? `Tension · Counterpoint ${targetLabel}`
        : firstSource
          ? `${SOURCE_BRANCH[firstSource.kind]} ${targetLabel}`
          : `Premise ${++premiseBranch} ${targetLabel}`;

    const cardId = `branch/${segIdx}`;
    elements[cardId] = {
      type: "Card",
      props: { title: label },
      children: stepIds,
    };
    children.push(cardId);
  });

  elements.outcome = { type: "TraceOutcome", props: { offerId }, children: [] };
  children.push("outcome");
  elements.root = {
    type: "Stack",
    props: { direction: "vertical", gap: "sm" },
    children,
  };
  return { root: "root", elements, state: {} } as Spec;
}
