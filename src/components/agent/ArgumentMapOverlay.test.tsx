// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { ArgumentMapOverlay } from "./ArgumentMapOverlay";
import type { ArgumentMapState } from "../editor/ArgumentMap";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let scroll: HTMLDivElement;
let editor: Editor;

/** Each 10 document positions are one 20px line, starting 100px down; the prose starts 60px in. */
const line = (pos: number) => ({ top: 100 + Math.floor(pos / 10) * 20, bottom: 120 + Math.floor(pos / 10) * 20, left: 60, right: 60 });

beforeEach(() => {
  scroll = document.body.appendChild(document.createElement("div"));
  scroll.setAttribute("data-editor-scroll", "");
  const dom = scroll.appendChild(document.createElement("div"));
  dom.getBoundingClientRect = () => new DOMRect(60, 0, 600, 2000);
  scroll.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  editor = { isDestroyed: false, state: { doc: { content: { size: 200 } } },
    view: { dom, coordsAtPos: vi.fn((pos: number) => line(pos)) }, on: vi.fn(), off: vi.fn() } as unknown as Editor;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  root = createRoot(scroll.appendChild(document.createElement("div")));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const render = (map: ArgumentMapState) => act(() => root.render(
  <ArgumentMapOverlay editor={editor} map={map} onSelect={vi.fn()}
    trace={[{ quote: "a", reading: "First.", sure: true }, { quote: "b", reading: "Then.", sure: false }]} />));

it("hangs a rail from the diamond down the whole highlight, thickest over the sentence the question is about", () => {
  render({ steps: [{ from: 2, to: 8, sure: true, index: 0, number: 1, via: [] }, { from: 42, to: 48, sure: false, index: 2, number: 2, via: ["web"] }],
    decision: { from: 61, to: 69, via: [], block: { from: 40, to: 95 } }, active: null, length: 3 });
  const nodes = [...scroll.querySelectorAll(".argument-map-node")];
  expect(nodes.map(node => node.getAttribute("transform"))).toEqual([
    "translate(48 110)", "translate(48 208)", "translate(48 190)"]);
  expect(nodes[1].hasAttribute("data-unsure")).toBe(true);
  // The step on the highlight's first line moves down onto the rail, a bead below the diamond.
  expect(nodes[2].hasAttribute("data-decision")).toBe(true);
  expect(scroll.querySelector(".argument-map-rail path")?.getAttribute("d")).toBe("M 48 200 V 300 h 5");
  const focus = scroll.querySelector(".argument-map-rail-focus")!;
  expect([focus.getAttribute("y"), focus.getAttribute("height")]).toEqual(["220", "20"]);
  expect(scroll.querySelector(".argument-map-via text")?.textContent).toBe("web");
  expect([...scroll.querySelectorAll(".argument-map-node text")].map(text => text.textContent)).toEqual(["1", "2"]);
});

it("shows a one-line highlight as the diamond alone", () => {
  render({ steps: [], decision: { from: 41, to: 45, via: [], block: { from: 40, to: 48 } }, active: null, length: 0 });
  expect(scroll.querySelector(".argument-map-rail")).toBeNull();
  expect(scroll.querySelectorAll(".argument-map-node")).toHaveLength(1);
});
