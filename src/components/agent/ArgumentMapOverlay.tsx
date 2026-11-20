import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { TraceRole, WritingTraceStep } from "../../lib/agent/writingOffers";
import type { ArgumentMapEdge, ArgumentMapState } from "../editor/ArgumentMap";
import "./ArgumentMapOverlay.css";

const NODE = { radius: 8, inset: 12, minBow: 10, bowPerPixel: 0.06, laneGap: 8, edge: 2, stack: 18 };
/** The rail hanging from the outcome diamond down the whole highlight. */
const RAIL = { gap: 10, foot: 5, focusWidth: 4, focusMin: 8, minLength: 4 };

interface Node {
  x: number;
  y: number;
  sure: boolean;
  decision: boolean;
  index: number;
  number: number;
  via: string[];
  role?: TraceRole;
}
interface Rail { x: number; top: number; bottom: number; focusTop: number; focusBottom: number }
interface Layout { width: number; height: number; nodes: Node[]; left: number; rtl: boolean; rail: Rail | null }

/**
 * Lays the argument map out in the note's margin: a numbered node beside each
 * passage the agent read, and an arrow from each one to the passage it led to.
 * It lives inside the scroll container so it scrolls with the text.
 */
function measure(editor: Editor, map: ArgumentMapState, container: HTMLElement): Layout | null {
  if (editor.isDestroyed || !editor.view.dom.isConnected) return null;
  const size = editor.state.doc.content.size;
  const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
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
    index: map.length, number: 0, via: map.decision.via };
  const nodes: Node[] = [];
  for (const step of map.steps) {
    const point = { x, y: lineMiddle(step.from) };
    // Two nodes on one line stack, so neither hides the other.
    while ([decision, ...nodes].some(node => Math.abs(node.y - point.y) < NODE.stack)) point.y += NODE.stack;
    nodes.push({ ...point, sure: step.sure, decision: false, index: step.index, number: step.number, via: step.via, role: step.role });
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

/** A curve that bows out into the margin, offset by lane when parallel branches overlap vertically. */
function arrow(from: Node, to: Node, layout: Layout, lane = 0): { d: string; middle: { x: number; y: number } } {
  const distance = Math.abs(to.y - from.y);
  const room = layout.rtl ? layout.width - NODE.edge - from.x : from.x - layout.left;
  const bow = Math.max(0, Math.min(room - NODE.radius, NODE.minBow + distance * NODE.bowPerPixel + lane * NODE.laneGap));
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

const VIA_LABELS: Record<string, string> = {
  web: "web", service: "mcp", you: "you", chat: "chat", note: "note", edit: "edit", trace: "map",
};

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

  useLayoutEffect(() => {
    if (!container) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setLayout(measure(editor, latest.current, container));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(editor.view.dom);
    observer.observe(container);
    window.addEventListener("resize", schedule);
    editor.on("transaction", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      editor.off("transaction", schedule);
    };
  }, [editor, mapKey, container]);

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
  const branchSet = new Set(map.branch ?? []);
  const incomingCounts = new Map<number, number>();
  for (const edge of edges) incomingCounts.set(edge.to, (incomingCounts.get(edge.to) ?? 0) + 1);
  const multiBranch = [...incomingCounts.values()].some(count => count > 1) ||
    edges.some(edge => edge.role === "tensions");
  const rootCounts = new Map<number, number>();

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

        if (edge.from === null) {
          if (!edge.via.length) return null;
          const seenAtTarget = rootCounts.get(edge.to) ?? 0;
          rootCounts.set(edge.to, seenAtTarget + 1);
          if (!multiBranch && layout.nodes.length > 1) return null;
          const dir = layout.rtl ? 1 : -1;
          const room = layout.rtl ? layout.width - NODE.edge - toNode.x : toNode.x - layout.left;
          const offset = Math.max(12, Math.min(room - 12, 22));
          const originX = toNode.x + dir * offset;
          const originY = Math.max(12, toNode.y - 16 - seenAtTarget * 16);
          const endX = toNode.x + dir * (NODE.radius + 3);
          const d = `M ${originX} ${originY + 6} Q ${originX} ${toNode.y}, ${endX} ${toNode.y}`;
          return <g key={`root-${idx}`}>
            <path className="argument-map-arrow" d={d} data-unsure={edge.unsure || undefined}
              data-role={edge.role === "tensions" ? "tensions" : undefined}
              data-active={isEdgeActive || undefined} data-branch={isOnBranch || undefined} markerEnd={marker} />
            <g className="argument-map-via" transform={`translate(${originX} ${originY})`}
              onClick={edge.steps.length ? () => onSelect(edge.steps[0]) : undefined}>
              <title>{`By way of ${edge.via.map(kind => VIA_LABELS[kind] ?? kind).join(", ")}`}</title>
              <rect x={-11} y={-6} width={22} height={12} rx={6} />
              <text textAnchor="middle" dominantBaseline="central">{VIA_LABELS[edge.via[0]] ?? edge.via[0]}{edge.via.length > 1 ? "+" : ""}</text>
            </g>
          </g>;
        }

        const fromNode = nodeByIndex.get(edge.from);
        if (!fromNode) return null;
        const { d, middle } = arrow(fromNode, toNode, layout, lanes.get(idx) ?? 0);
        return <g key={`arrow-${idx}`}>
          <path className="argument-map-arrow" d={d} data-unsure={edge.unsure || undefined}
            data-role={edge.role === "tensions" ? "tensions" : undefined}
            data-active={isEdgeActive || undefined} data-branch={isOnBranch || undefined} markerEnd={marker} />
          {edge.via.length > 0 && <g className="argument-map-via" transform={`translate(${middle.x} ${middle.y})`}
            onClick={edge.steps.length > 1 ? () => onSelect(edge.steps[1]) : undefined}>
            {/* What this branch drew on between these passages, outside the note. */}
            <title>{`By way of ${edge.via.map(kind => VIA_LABELS[kind] ?? kind).join(", ")}`}</title>
            <rect x={-11} y={-6} width={22} height={12} rx={6} />
            <text textAnchor="middle" dominantBaseline="central">{VIA_LABELS[edge.via[0]] ?? edge.via[0]}{edge.via.length > 1 ? "+" : ""}</text>
          </g>}
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
          {!node.decision && <text textAnchor="middle" dominantBaseline="central">{node.number}</text>}
        </g>
      ))}
    </svg>, container,
  );
}
