import { useEffect, useId, useRef } from "react";
import type { AgentExpression } from "../../services/agent";
import faceShell from "../../assets/agent-face.png";
import type { InlineActivityState } from "./InlineAgentActivity";
import "./InlineAgentFace.css";

// Runtime states outrank expressive metadata. A cheerful model response must
// never leave the companion smiling through a failure or cancellation.
function expressionFor(state: InlineActivityState, expression?: AgentExpression): AgentExpression {
  if (state === "error") return { expression: "concerned", sentiment: -0.6, intensity: 0.7 };
  if (state === "paused") return { expression: "neutral", sentiment: 0, intensity: 0 };
  if (state === "waiting") return { expression: "curious", sentiment: 0, intensity: 0.5 };
  return expression ?? { expression: state === "editing" ? "focused" : "neutral", sentiment: 0, intensity: 0.4 };
}

export function InlineAgentFace({ state, expression }: { state: InlineActivityState; expression?: AgentExpression }) {
  const shellMask = useId();
  const face = useRef<SVGSVGElement>(null);
  const attention = useRef<SVGGElement>(null);
  const emotion = expressionFor(state, expression);
  const { intensity, sentiment } = emotion;
  const focus = emotion.expression === "focused" ? intensity : 0;
  const curiosity = emotion.expression === "curious" ? intensity : 0;
  const uncertainty = emotion.expression === "uncertain" ? intensity : 0;
  const concern = emotion.expression === "concerned" ? intensity : 0;
  const pleasure = emotion.expression === "pleased" ? intensity : 0;
  const eyeHeight = 3.2 - focus * 1.4 + curiosity * 0.6;
  const tilt = concern * 16 + uncertainty * 10;
  const radius = 1.6 + sentiment * 0.3;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let x = 0;
    let y = 0;
    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      attention.current?.style.removeProperty("transform");
    };
    const update = () => {
      frame = 0;
      const bounds = face.current?.getBoundingClientRect();
      if (!bounds || !attention.current) return;
      const dx = Math.max(-1.8, Math.min(1.8, (x - bounds.x - bounds.width / 2) / 140));
      const dy = Math.max(-1.4, Math.min(1.4, (y - bounds.y - bounds.height / 2) / 180));
      attention.current.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const move = (event: PointerEvent) => {
      if (media.matches || event.pointerType === "touch") return;
      x = event.clientX;
      y = event.clientY;
      if (!frame) frame = requestAnimationFrame(update);
    };
    // Pointer positions stay local. They are never sent to the model.
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("blur", reset);
    document.documentElement.addEventListener("pointerleave", reset);
    media.addEventListener("change", reset);
    return () => {
      reset();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("blur", reset);
      document.documentElement.removeEventListener("pointerleave", reset);
      media.removeEventListener("change", reset);
    };
  }, []);

  return (
    <svg ref={face} className="inline-agent-face" data-state={state} data-expression={emotion.expression} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <mask id={shellMask} style={{ maskType: "alpha" }}>
          <image href={faceShell} width="40" height="40" />
        </mask>
      </defs>
      <path d="M0 0H40V40H0Z" fill="currentColor" mask={`url(#${shellMask})`} />
      <g ref={attention} className="inline-agent-attention">
        <g className="inline-agent-gaze">
          {[12.4, 24.4].map((x, index) => (
            <g key={x} className="inline-agent-emotion" style={{ transform: `rotate(${index === 0 ? -tilt : tilt}deg)` }}>
              {pleasure > 0.25 ?
                <path className="inline-agent-eye" d={`M${x} 25 Q${x + 1.6} ${24 - pleasure * 2} ${x + 3.2} 25 L${x + 3.2} 26 Q${x + 1.6} ${26 - pleasure * 2} ${x} 26 Z`} /> :
                <rect className="inline-agent-eye" x={x} y={25 - eyeHeight / 2} width="3.2" height={eyeHeight - (index === 1 ? uncertainty : 0)} rx={radius} />}
            </g>
          ))}
        </g>
      </g>
      <path className="inline-agent-signal" d={`M18 30 Q20 ${30 + sentiment * 2} 22 30`} />
    </svg>
  );
}
