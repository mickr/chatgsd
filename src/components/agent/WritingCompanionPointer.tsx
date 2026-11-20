import { useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { tracePlaybackOrder, type PreparedWritingOffer, type WritingRange } from "../../lib/agent/writingOffers";
import "./WritingCompanionPointer.css";

/* ANIMATION STORYBOARD
 * The cursor emerges from the companion, reads each argument waypoint, then
 * settles at the question. A move picks up a paragraph ghost on its second leg.
 * Scrolling cancels the sequence; reduced motion shows only the destination.
 */
const TIMING = { arrive: 1100, travel: 620, pause: 280, ghostHold: 900 };
const POINTER = { size: 20, gap: 3, tipY: 2, lift: 90, samples: 32,
  easing: "cubic-bezier(.25, .1, .2, 1)" };
type Point = { left: number; top: number; zoom: number; rtl: boolean; ghostWidth: number };

export function WritingCompanionPointer({ editor, range, kind, originRef, replayTrigger = 0, preparedOffer = null, followTarget = null }: {
  editor: Editor;
  range: { from: number; to: number };
  kind: "clarity" | "evidence" | "development";
  originRef: RefObject<HTMLElement | null>;
  replayTrigger?: number;
  preparedOffer?: PreparedWritingOffer | null;
  /**
   * The argument map is open, and this is the block of the step being read. The
   * cursor reads beside it in the right margin (the left holds the map), hopping
   * from step to step, and stays there.
   */
  followTarget?: WritingRange | null;
}) {
  const followTrace = !!followTarget;
  const lastPoint = useRef<{ left: number; top: number } | null>(null);
  const marker = useRef<HTMLDivElement>(null);
  const introduction = useRef<{ editor: Editor; key: string; shown: boolean } | null>(null);
  // Opening the map replays through replayTrigger; closing it only re-settles.
  const gestureKey = JSON.stringify([replayTrigger, followTarget?.from ?? null, preparedOffer
    ? [preparedOffer.documentSession, preparedOffer.offer] : range]);

  useLayoutEffect(() => {
    const element = marker.current;
    if (!element) return;
    const move = preparedOffer?.offer.kind === "move" && !followTarget;
    const destination = followTarget ?? (move ? preparedOffer.destination ?? preparedOffer.sourceBlock
      : preparedOffer?.sourceBlock ?? range);
    const orderedBlocks = preparedOffer?.offer.kind === "question"
      ? tracePlaybackOrder(preparedOffer.offer.trace)
          .slice(0, -1)
          .flatMap((idx) => {
            const range = preparedOffer.trace[idx];
            if (!range) return [];
            const $pos = editor.state.doc.resolve(Math.min(range.from, editor.state.doc.content.size));
            return $pos.depth ? [{ from: $pos.before($pos.depth), to: $pos.after($pos.depth) }] : [];
          })
      : [];
    const steps = followTarget ? [followTarget] : preparedOffer?.offer.kind === "question"
      ? [...(orderedBlocks.length ? orderedBlocks : preparedOffer.traceBlocks)
          .filter((block, index, all) => block.from !== destination.from &&
            all.findIndex((other) => other.from === block.from) === index), destination]
      : move ? [preparedOffer.sourceBlock, destination] : [destination];
    let frame = 0;
    let pause: ReturnType<typeof setTimeout> | undefined;
    let ghostTimer: ReturnType<typeof setTimeout> | undefined;
    // Refreshing an offer remaps its anchors as the writer types. That should
    // settle the existing gesture, never replay it from the companion.
    if (introduction.current?.editor !== editor || introduction.current.key !== gestureKey)
      introduction.current = { editor, key: gestureKey, shown: false };
    const gesture = introduction.current;
    let introduced = gesture.shown;
    let disposed = false;
    let animation: Animation | undefined;
    let previousGeometry = "";
    let hopping = false;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const settle = () => {
      if (animation) { animation.onfinish = null; animation.cancel(); animation = undefined; }
      clearTimeout(pause);
      clearTimeout(ghostTimer);
      pause = undefined;
      ghostTimer = undefined;
      element.dataset.carry = "false";
      element.dataset.motion = "settled";
    };
    const locate = (target: WritingRange): Point | null => {
      if (editor.isDestroyed || !editor.view.dom.isConnected || target.from < 0 ||
          target.to > editor.state.doc.content.size || target.from >= target.to) return null;
      const viewport = editor.view.dom.closest<HTMLElement>("[data-editor-content-area]");
      const scroll = editor.view.dom.closest<HTMLElement>("[data-editor-scroll]");
      if (!viewport || !editor.view.dom.getClientRects().length) return null;
      const block = editor.view.nodeDOM(target.from);
      if (!(block instanceof HTMLElement) || !block.getClientRects().length) return null;
      const bounds = block.getBoundingClientRect();
      const area = viewport.getBoundingClientRect();
      const scrolling = scroll?.getBoundingClientRect() ?? area;
      const clip = { left: Math.max(0, area.left, scrolling.left),
        right: Math.min(window.innerWidth, area.right, scrolling.right),
        top: Math.max(0, area.top, scrolling.top),
        bottom: Math.min(window.innerHeight, area.bottom, scrolling.bottom) };
      const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const size = POINTER.size * zoom;
      const rtl = getComputedStyle(block).direction === "rtl";
      const line = editor.view.coordsAtPos(Math.min(target.from + 1, target.to));
      const editorBounds = editor.view.dom.getBoundingClientRect();
      const editorStyle = getComputedStyle(editor.view.dom);
      const proseLeft = editorBounds.left + (Number.parseFloat(editorStyle.paddingLeft) || 0) * zoom;
      const proseRight = editorBounds.right - (Number.parseFloat(editorStyle.paddingRight) || 0) * zoom;
      // Following the map, the cursor reads from the margin opposite it.
      const right = rtl !== followTrace;
      const left = right ? Math.max(bounds.right, proseRight) + POINTER.gap * zoom
        : Math.min(bounds.left, proseLeft) - (POINTER.gap + POINTER.size) * zoom;
      const top = (line.top + line.bottom) / 2 - POINTER.tipY * zoom;
      // Hiding, rather than clamping, keeps every gesture grounded in its line.
      if (left < clip.left || left + size > clip.right || top < clip.top || top + size > clip.bottom ||
          line.top < clip.top || line.bottom > clip.bottom) return null;
      const availableWidth = (right ? clip.right - left : left + size - clip.left) / zoom;
      const availableHeight = (clip.bottom - top) / zoom - POINTER.size - 4;
      return { left: left / zoom, top: top / zoom, zoom, rtl: right,
        ghostWidth: Math.max(0, Math.min(160, availableWidth, availableHeight * 160 / 76)) };
    };
    const place = (point: Point) => {
      lastPoint.current = { left: point.left, top: point.top };
      element.style.left = `${point.left}px`;
      element.style.top = `${point.top}px`;
      const compact = point.ghostWidth < 120;
      element.dataset.ghostSize = compact ? "compact" : "full";
      element.style.setProperty("--ghost-scale", `${compact ? Math.min(1, point.ghostWidth / 48) : point.ghostWidth / 160}`);
      element.dataset.direction = point.rtl ? "rtl" : "ltr";
      element.hidden = false;
    };
    const position = () => {
      frame = 0;
      const finalPoint = locate(destination);
      if (!finalPoint) { settle(); element.hidden = true; return; }
      const points = steps.map(locate);
      const geometry = JSON.stringify(points);
      if (introduced && previousGeometry === geometry) return;
      previousGeometry = geometry;
      // Following the map, the cursor hops on from where it was rather than flying in from the panel again.
      const hopFrom = followTrace && !introduced ? lastPoint.current : null;
      settle();
      place(finalPoint);
      if (introduced) return;
      introduced = true;
      gesture.shown = true;
      hopping = !!hopFrom;
      const origin = originRef.current?.querySelector(".inline-agent-face") ?? originRef.current;
      if (motion.matches || (!hopFrom && !origin?.getClientRects().length)) return;
      const visible = points.filter((point): point is Point => point !== null);
      // If pickup is offscreen, show the proposal at its destination without a
      // fictional pickup. Never scroll or move the writer's selection for a tour.
      if (move && !points[0]) return;
      const travel = (index: number, from: { left: number; top: number }) => {
        if (disposed) return;
        const target = visible[index];
        place(target);
        element.dataset.carry = move && index > 0 ? "true" : "false";
        const x = from.left - target.left;
        const y = from.top - target.top;
        const lift = Math.min(POINTER.lift, Math.abs(y) / 2);
        const keyframes = Array.from({ length: POINTER.samples + 1 }, (_, sample) => {
          const t = sample / POINTER.samples;
          const remaining = 1 - t;
          const dx = remaining ** 3 * x + 3 * remaining ** 2 * t * x;
          const dy = remaining ** 3 * y + 3 * remaining ** 2 * t * (y - lift) +
            3 * remaining * t ** 2 * (y / 2);
          return { transform: `translate(${dx}px, ${dy}px)`, opacity: index ? 1 : Math.min(1, t * 8), offset: t };
        });
        element.dataset.motion = "travelling";
        animation = element.animate(keyframes, { duration: index || hopping ? TIMING.travel : TIMING.arrive,
          easing: POINTER.easing, fill: "both" });
        animation.onfinish = () => {
          element.dataset.motion = index === visible.length - 1 ? "settled" : "reading";
          if (move && index === visible.length - 1) ghostTimer = setTimeout(() => {
            element.dataset.carry = "false";
          }, TIMING.ghostHold);
          if (index < visible.length - 1) pause = setTimeout(() => {
            settle();
            travel(index + 1, target);
          }, TIMING.pause);
        };
      };
      if (hopFrom) { travel(0, hopFrom); return; }
      const source = origin!.getBoundingClientRect();
      travel(0, { left: (source.left + source.width / 2) / finalPoint.zoom - POINTER.size / 2,
        top: (source.top + source.height / 2) / finalPoint.zoom - POINTER.size / 2 });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(position); };
    const interrupt = () => { previousGeometry = ""; schedule(); };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(editor.view.dom);
    const viewport = editor.view.dom.closest<HTMLElement>("[data-editor-content-area]");
    if (viewport) observer.observe(viewport);
    steps.forEach((step) => {
      const block = editor.view.nodeDOM(step.from);
      if (block instanceof HTMLElement) observer.observe(block);
    });
    window.addEventListener("scroll", interrupt, true);
    window.addEventListener("resize", schedule);
    editor.on("transaction", interrupt);
    motion.addEventListener("change", interrupt);
    return () => {
      disposed = true;
      settle();
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", interrupt, true);
      window.removeEventListener("resize", schedule);
      editor.off("transaction", interrupt);
      motion.removeEventListener("change", interrupt);
    };
  }, [editor, range.from, range.to, originRef, replayTrigger, preparedOffer, gestureKey, followTrace]);

  return createPortal(
    <div ref={marker} className="writing-companion-pointer" data-kind={kind} data-offer-kind={followTrace ? undefined : preparedOffer?.offer.kind}
      data-follow-trace={followTrace || undefined} aria-hidden="true" hidden
      style={{ width: POINTER.size, height: POINTER.size }}>
      <svg viewBox="0 0 20 20" focusable="false">
        <path d="M18 2 2 9.5l6.7 2.1 3.1 6.4Z" />
      </svg>
      {preparedOffer?.offer.kind === "move" && !followTrace && <div className="writing-companion-pointer-ghost">
        <span className="writing-companion-pointer-ghost-label">Move preview</span>
        <span className="writing-companion-pointer-ghost-excerpt">{preparedOffer.offer.quote}</span>
        <span className="writing-companion-pointer-ghost-thumbnail"><i /><i /><i /></span>
      </div>}
    </div>, document.body,
  );
}
