import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { TraceRole, WritingTraceStep } from "../../lib/agent/writingOffers";
import type { ArgumentMapEdge, ArgumentMapState } from "../editor/ArgumentMap";
import "./ArgumentMapOverlay.css";

const NODE = { radius: 8, inset: 12, minBow: 10, bowPerPixel: 0.06, laneGap: 8, edge: 2, stack: 18 };
/** The rail hanging from the outcome diamond down the whole highlight. */
const RAIL = { gap: 10, foot: 5, focusWidth: 4, focusMin: 8, minLength: 4 };
/** A step with no place in the note, drawn as a numbered pill on the branch it belongs to. */
// As tall as the gap between the nodes of two neighbouring lines, so a pill between them touches neither.
const PILL = { height: 12, gap: 2, pad: 5, charWidth: 5, rootOffset: 22, rootRise: 16 };
/** With less margin than this beside the text there is nowhere to draw, so the text makes room (see the gutter rule in the stylesheet). */
const MIN_MARGIN = 32;

interface Node {
  x: number;
  y: number;
  sure: boolean;
  decision: boolean;
  index: number;
  via: string[];
  role?: TraceRole;
}
interface Rail { x: number; top: number; bottom: number; focusTop: number; focusBottom: number }
interface Layout { width: number; height: number; nodes: Node[]; left: number; rtl: boolean; rail: Rail | null }

const pageZoom = () => Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;

/** Asks the text for a gutter while the margin beside it is too narrow to draw the map in. */
function reserveGutter(editor: Editor, container: HTMLElement): void {
  if (editor.isDestroyed || !editor.view.dom.isConnected) return;
  const box = container.getBoundingClientRect();
  const prose = editor.view.dom.getBoundingClientRect();
  const rtl = getComputedStyle(editor.view.dom).direction === "rtl";
  // The text's outer box doesn't move when its padding grows, so the gutter can't undo the reason for itself.
  const margin = (rtl ? box.right - prose.right : prose.left - box.left) / pageZoom();
  const gutter = margin < MIN_MARGIN ? (rtl ? "right" : "left") : undefined;
  // Asked again on every layout, so it only touches the note when the answer changes.
  if (container.dataset.argumentMapGutter === gutter) return;
  if (gutter) container.dataset.argumentMapGutter = gutter;
  else delete container.dataset.argumentMapGutter;
}

/**
 * Lays the argument map out in the note's margin: a numbered node beside each
 * passage the agent read, and an arrow from each one to the passage it led to.
 * It lives inside the scroll container so it scrolls with the text.
 */
function measure(editor: Editor, map: ArgumentMapState, container: HTMLElement): Layout | null {
  if (editor.isDestroyed || !editor.view.dom.isConnected) return null;
  const size = editor.state.doc.content.size;
  const zoom = pageZoom();
  const box = container.getBoundingClientRect();
  const prose = editor.view.dom.getBoundingClientRect();
  const style = getComputedStyle(editor.view.dom);
  const rtl = style.direction === "rtl";
  const padding = Number.parseFloat(rtl ? style.paddingRight : style.paddingLeft) || 0;
  const edge = rtl ? prose.right - padding * zoom : prose.left + padding * zoom;
  const toLocal = (clientX: number, clientY: number) => ({
    x: (clientX - box.left) / zoom + container.scrollLeft,
    y: (clientY - box.top) / zoom + container.scrollTop,
  });
  const valid = (range: { from: number; to: number }) => range.from >= 0 && range.to <= size && range.from < range.to;
  const x = toLocal(rtl ? edge + NODE.inset * zoom : edge - NODE.inset * zoom, 0).x;
  const lineMiddle = (pos: number) => {
    const line = editor.view.coordsAtPos(pos);
    return toLocal(0, (line.top + line.bottom) / 2).y;
  };
  const { block } = map.decision;
  if (!valid(map.decision) || (block && !valid(block)) || !map.steps.every(valid)) return null;
  // The diamond is placed first, at the outcome's opening line, so a step on that line moves aside for it.
  const decision: Node = { x, y: lineMiddle((block ?? map.decision).from), sure: true, decision: true,
    index: map.length, via: map.decision.via };
  const nodes: Node[] = [];
  for (const step of map.steps) {
    const point = { x, y: lineMiddle(step.from) };
    // Two nodes on one line stack, so neither hides the other.
    while ([decision, ...nodes].some(node => Math.abs(node.y - point.y) < NODE.stack)) point.y += NODE.stack;
    nodes.push({ ...point, sure: step.sure, decision: false, index: step.index, via: step.via, role: step.role });
  }
  nodes.push(decision);
  let rail: Rail | null = null;
  if (block) {
    const top = decision.y + RAIL.gap;
    const bottom = toLocal(0, editor.view.coordsAtPos(block.to, -1).bottom).y;
    const focusTop = Math.max(top, toLocal(0, editor.view.coordsAtPos(map.decision.from).top).y);
    const focusBottom = Math.min(bottom, Math.max(focusTop + RAIL.focusMin,
      toLocal(0, editor.view.coordsAtPos(map.decision.to, -1).bottom).y));
    // A one-line highlight is just the diamond.
    if (bottom - top >= RAIL.minLength) rail = { x, top, bottom, focusTop, focusBottom };
  }
  const left = toLocal(box.left, box.top).x + NODE.edge;
  // Sized to the map, not the scroll height, so it never lengthens the note.
  const height = Math.max(rail?.bottom ?? 0, ...nodes.map(node => node.y)) + NODE.radius + NODE.stack;
  return { width: container.clientWidth, height, nodes, left, rtl, rail };
}

/** How far the margin runs outward from a node before the edge of the note. */
const marginRoom = (node: Node, layout: Layout) => layout.rtl ? layout.width - NODE.edge - node.x : node.x - layout.left;

/**
 * A curve that bows out into the margin, offset by lane when parallel branches
 * overlap vertically. In a tight margin the lanes close up and the innermost bow
 * gives way first, so branches never collapse onto one line.
 */
function arrow(from: Node, to: Node, layout: Layout, lane = 0, lanes = 1): { d: string; middle: { x: number; y: number } } {
  const distance = Math.abs(to.y - from.y);
  const room = Math.max(0, marginRoom(from, layout) - NODE.radius);
  const gap = lanes > 1 ? Math.min(NODE.laneGap, Math.max(0, room - NODE.minBow) / (lanes - 1)) : 0;
  const bow = Math.min(NODE.minBow + distance * NODE.bowPerPixel, room - (lanes - 1) * gap) + lane * gap;
  const out = layout.rtl ? from.x + bow : from.x - bow;
  const direction = to.y >= from.y ? 1 : -1;
  const start = from.y + direction * (NODE.radius + 2);
  const end = to.y - direction * (NODE.radius + 4);
  // A cubic with both controls at out peaks three quarters of the way there.
  return { d: `M ${from.x} ${start} C ${out} ${start + direction * distance * 0.25}, ${out} ${end - direction * distance * 0.25}, ${to.x} ${end}`,
    middle: { x: from.x + (out - from.x) * 0.75, y: (start + end) / 2 } };
}

/** Assign non-colliding horizontal bow lanes: shorter spans hug the prose, wider spans arch outside them. */
function assignLanes(edges: readonly ArgumentMapEdge[], nodeByIndex: ReadonlyMap<number, Node>): Map<number, number> {
  const spans = edges.flatMap((edge, idx) => {
    if (edge.from === null) return [];
    const a = nodeByIndex.get(edge.from);
    const b = nodeByIndex.get(edge.to);
    if (!a || !b) return [];
    return [{ idx, top: Math.min(a.y, b.y) + 2, bottom: Math.max(a.y, b.y) - 2, span: Math.abs(b.y - a.y) }];
  });
  spans.sort((a, b) => a.span - b.span || a.idx - b.idx);
  const lanes: Array<Array<{ top: number; bottom: number }>> = [];
  const result = new Map<number, number>();
  for (const item of spans) {
    let lane = lanes.findIndex(occupied => occupied.every(prev => item.bottom <= prev.top || item.top >= prev.bottom));
    if (lane === -1) { lane = lanes.length; lanes.push([]); }
    lanes[lane].push({ top: item.top, bottom: item.bottom });
    result.set(item.idx, lane);
  }
  return result;
}

/** What a pill is labelled and what its tooltip calls it, by the kind of step. */
const VIA: Record<string, { label: string; name: string }> = {
  web: { label: "web", name: "Web research" },
  service: { label: "mcp", name: "Connected service" },
  you: { label: "you", name: "You said" },
  chat: { label: "chat", name: "Earlier discussion" },
  note: { label: "note", name: "Other notes" },
  edit: { label: "edit", name: "My edit" },
  trace: { label: "map", name: "Earlier map" },
  removed: { label: "cut", name: "No longer in the note" },
};

interface Pill { kind: string; step: number | null; label: string; width: number }

/** One pill per step the branch passes through outside the note, each carrying that step's number. */
function pillsFor(edge: ArgumentMapEdge): Pill[] {
  const outside = edge.from === null ? edge.steps : edge.steps.slice(1);
  return edge.via.map((kind, position) => {
    const step = outside[position] ?? null;
    const label = `${step === null ? "" : `${step + 1} `}${VIA[kind]?.label ?? kind}`;
    return { kind, step, label, width: PILL.pad * 2 + label.length * PILL.charWidth };
  });
}

export function ArgumentMapOverlay({ editor, map, trace, onSelect }: {
  editor: Editor;
  map: ArgumentMapState;
  trace: WritingTraceStep[];
  onSelect: (index: number) => void;
}) {
  const container = editor.view.dom.closest<HTMLElement>("[data-editor-scroll]");
  const [layout, setLayout] = useState<Layout | null>(null);
  // The map arrives as a fresh object each render; lay out again only when it changes.
  const latest = useRef(map);
  latest.current = map;
  const mapKey = JSON.stringify(map);

  const layOut = useRef<() => void>(() => {});

  // Follows the note for as long as the map is open. The gutter is asked for once and given back on close.
  useLayoutEffect(() => {
    if (!container) return;
    let frame = 0;
    let open = true;
    const update = () => {
      frame = 0;
      reserveGutter(editor, container);
      setLayout(measure(editor, latest.current, container));
    };
    // Fonts can finish loading after the map has closed; nothing may touch the note's gutter then.
    const schedule = () => { if (open && !frame) frame = requestAnimationFrame(update); };
    layOut.current = update;
    const observer = new ResizeObserver(schedule);
    observer.observe(editor.view.dom);
    observer.observe(container);
    window.addEventListener("resize", schedule);
    editor.on("transaction", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      open = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      editor.off("transaction", schedule);
      delete container.dataset.argumentMapGutter;
    };
  }, [editor, container]);
  useLayoutEffect(() => layOut.current(), [editor, container, mapKey]);

  if (!container || !layout) return null;
  const nodeByIndex = new Map(layout.nodes.map(node => [node.index, node]));
  const edges: ArgumentMapEdge[] = map.edges ?? layout.nodes.slice(0, -1).map((node, idx) => {
    const next = layout.nodes[idx + 1];
    return {
      from: node.index,
      to: next.index,
      via: next.via,
      unsure: !node.sure,
      role: node.role ?? "supports",
      steps: [node.index],
    };
  });
  const lanes = assignLanes(edges, nodeByIndex);
  const laneCount = Math.max(0, ...lanes.values()) + 1;
  const branchSet = new Set(map.branch ?? []);
  const incomingCounts = new Map<number, number>();
  for (const edge of edges) incomingCounts.set(edge.to, (incomingCounts.get(edge.to) ?? 0) + 1);
  const multiBranch = [...incomingCounts.values()].some(count => count > 1) ||
    edges.some(edge => edge.role === "tensions");
  const rootPills = new Map<number, number>();
  const pill = (item: Pill, x: number, y: number, key: string) => {
    const step = item.step;
    return <g key={key} className="argument-map-via" transform={`translate(${x} ${y})`}
      data-active={(step !== null && map.active === step) || undefined}
      data-unsure={(step !== null && trace[step]?.sure === false) || undefined}
      onClick={step === null ? undefined : () => onSelect(step)}>
      <title>{`${VIA[item.kind]?.name ?? item.kind}${step === null ? "" : `: ${trace[step]?.reading ?? ""}`}`}</title>
      <rect x={-item.width / 2} y={-PILL.height / 2} width={item.width} height={PILL.height} rx={PILL.height / 2} />
      <text textAnchor="middle" dominantBaseline="central">{item.label}</text>
    </g>;
  };

  return createPortal(
    <svg className="argument-map-overlay" width={layout.width} height={layout.height}
      data-branch-focus={(multiBranch && map.active !== null && map.active < map.length) || undefined}
      aria-hidden="true">
      <defs>
        <marker id="argument-map-arrowhead" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 8 4 L 0 8 z" />
        </marker>
        <marker id="argument-map-arrowhead-tension" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 8 4 L 0 8 z" />
        </marker>
      </defs>
      {layout.rail && <g className="argument-map-rail" data-active={map.active === map.length || undefined}>
        {/* The whole highlight, hanging from the diamond, with a foot turned toward the text. */}
        <path d={`M ${layout.rail.x} ${layout.rail.top} V ${layout.rail.bottom} h ${layout.rtl ? -RAIL.foot : RAIL.foot}`} />
        <rect className="argument-map-rail-focus" x={layout.rail.x - RAIL.focusWidth / 2} y={layout.rail.focusTop}
          width={RAIL.focusWidth} height={layout.rail.focusBottom - layout.rail.focusTop} rx={2} />
      </g>}
      {edges.map((edge, idx) => {
        const toNode = nodeByIndex.get(edge.to);
        if (!toNode) return null;
        const isEdgeActive = map.active !== null && (map.active === edge.to || edge.steps.includes(map.active));
        const isOnBranch = branchSet.size > 0 && branchSet.has(edge.to) &&
          (edge.from !== null ? branchSet.has(edge.from) : edge.steps.some(step => branchSet.has(step)));
        const marker = edge.role === "tensions" ? "url(#argument-map-arrowhead-tension)" : "url(#argument-map-arrowhead)";
        const pills = pillsFor(edge);
        const pitch = PILL.height + PILL.gap;

        if (edge.from === null) {
          if (!pills.length) return null;
          const below = rootPills.get(edge.to) ?? 0;
          rootPills.set(edge.to, below + pills.length);
          const dir = layout.rtl ? 1 : -1;
          const widest = Math.max(...pills.map(item => item.width));
          // Kept inside the note: in a tight margin the pills sit above the node rather than beside it.
          const offset = Math.max(0, Math.min(marginRoom(toNode, layout) - widest / 2, PILL.rootOffset));
          const originX = toNode.x + dir * offset;
          // The branch reads downward: its last step sits nearest the node it leads into.
          const pillY = (position: number) =>
            Math.max(PILL.height / 2, toNode.y - PILL.rootRise - (below + pills.length - 1 - position) * pitch);
          const startY = pillY(pills.length - 1) + PILL.height / 2;
          const endX = toNode.x + dir * (NODE.radius + 3);
          const d = offset > NODE.radius + 3
            ? `M ${originX} ${startY} Q ${originX} ${toNode.y}, ${endX} ${toNode.y}`
            : `M ${originX} ${startY} V ${toNode.y - NODE.radius - 3}`;
          return <g key={`root-${idx}`}>
            <path className="argument-map-arrow" d={d} data-unsure={edge.unsure || undefined}
              data-role={edge.role === "tensions" ? "tensions" : undefined}
              data-active={isEdgeActive || undefined} data-branch={isOnBranch || undefined} markerEnd={marker} />
            {pills.map((item, position) => pill(item, originX, pillY(position), `root-${idx}-${position}`))}
          </g>;
        }

        const fromNode = nodeByIndex.get(edge.from);
        if (!fromNode) return null;
        const { d, middle } = arrow(fromNode, toNode, layout, lanes.get(idx) ?? 0, laneCount);
        const direction = toNode.y >= fromNode.y ? 1 : -1;
        return <g key={`arrow-${idx}`}>
          <path className="argument-map-arrow" d={d} data-unsure={edge.unsure || undefined}
            data-role={edge.role === "tensions" ? "tensions" : undefined}
            data-active={isEdgeActive || undefined} data-branch={isOnBranch || undefined} markerEnd={marker} />
          {/* What this branch drew on between these passages, outside the note, in the order it read them. */}
          {pills.map((item, position) => pill(item, middle.x,
            middle.y + direction * (position - (pills.length - 1) / 2) * pitch, `arrow-${idx}-${position}`))}
        </g>;
      })}
      {layout.nodes.map((node) => (
        <g key={`node-${node.index}`} className="argument-map-node" data-decision={node.decision || undefined}
          data-unsure={!node.sure || undefined} data-role={node.role === "tensions" ? "tensions" : undefined}
          data-active={map.active === node.index || undefined}
          data-branch={branchSet.has(node.index) || undefined}
          transform={`translate(${node.x} ${node.y})`} onClick={() => onSelect(node.index)}>
          <title>{node.decision ? "Where it converges" : `${node.role === "tensions" ? "Tension: " : ""}${trace[node.index]?.sure === false ? "Unsure (click to clarify): " : ""}${trace[node.index]?.reading ?? ""}`}</title>
          {node.decision
            ? <rect x={-NODE.radius + 1} y={-NODE.radius + 1} width={(NODE.radius - 1) * 2} height={(NODE.radius - 1) * 2} rx="2" transform="rotate(45)" />
            : <circle r={NODE.radius} />}
          {!node.decision && <text textAnchor="middle" dominantBaseline="central">{node.index + 1}</text>}
        </g>
      ))}
    </svg>, container,
  );
}
