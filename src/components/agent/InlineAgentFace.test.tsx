// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InlineAgentFace } from "./InlineAgentFace";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let media: EventTarget & { matches: boolean };
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  media = Object.assign(new EventTarget(), { matches: false });
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 40, 40));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const gaze = () => container.querySelector<SVGGElement>(".inline-agent-attention")!;
function flushFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}
function move(x: number, y: number) {
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));
}

it("expresses semantic focus, sentiment, and pleasure without changing activity", () => {
  act(() => root.render(<InlineAgentFace state="reading" expression={{ expression: "neutral", sentiment: 0, intensity: 0.6 }} />));
  const baselineHeight = Number(container.querySelector("rect")!.getAttribute("height"));
  act(() => root.render(<InlineAgentFace state="reading" expression={{ expression: "focused", sentiment: -0.5, intensity: 0.8 }} />));
  const focusedEye = container.querySelector("rect")!;
  expect(Number(focusedEye.getAttribute("height"))).toBeLessThan(baselineHeight);
  const negativeRadius = Number(focusedEye.getAttribute("rx"));
  act(() => root.render(<InlineAgentFace state="reading" expression={{ expression: "focused", sentiment: 0.5, intensity: 0.8 }} />));
  expect(Number(container.querySelector("rect")!.getAttribute("rx"))).toBeGreaterThan(negativeRadius);
  act(() => root.render(<InlineAgentFace state="reading" expression={{ expression: "pleased", sentiment: 0.8, intensity: 0.8 }} />));
  expect(container.querySelector("path.inline-agent-eye")).not.toBeNull();
  expect(container.querySelector("svg")!.dataset.state).toBe("reading");
  act(() => root.render(<InlineAgentFace state="error" expression={{ expression: "pleased", sentiment: 1, intensity: 1 }} />));
  expect(container.querySelector("path.inline-agent-eye")).toBeNull();
  expect(container.querySelector("svg")!.dataset.expression).toBe("concerned");
});

it("follows the latest pointer position within the visor and recenters on blur", () => {
  act(() => root.render(<InlineAgentFace state="thinking" />));
  move(-1000, -1000);
  move(1000, 1000);
  flushFrame();
  expect(gaze().style.transform).toBe("translate(1.8px, 1.4px)");
  move(1000, 1000);
  window.dispatchEvent(new Event("blur"));
  flushFrame();
  expect(gaze().style.transform).toBe("");
});

it("cancels gaze motion when reduced motion is enabled, including a pending frame", () => {
  act(() => root.render(<InlineAgentFace state="reading" />));
  move(1000, 1000);
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  flushFrame();
  move(-1000, -1000);
  flushFrame();
  expect(gaze().style.transform).toBe("");
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  move(1000, 1000);
  flushFrame();
  expect(gaze().style.transform).toBe("translate(1.8px, 1.4px)");
});
