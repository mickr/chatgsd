// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { ArgumentMapOverlay } from "./ArgumentMapOverlay";
import { argumentMapFor, type ArgumentMapState } from "../editor/ArgumentMap";

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

it("draws converging branches in distinct bow lanes and marks tension and off-page root branches", () => {
  const map = argumentMapFor({
    trace: [{ from: 2, to: 8 }, { from: 22, to: 28 }, null],
    source: { from: 61, to: 69 },
    provenance: [null, null, { kind: "web" }],
    offer: {
      trace: [
        { sure: true, leads_to: null },
        { sure: true, leads_to: null, role: "tensions" },
        { sure: false, leads_to: null },
      ],
    },
  }, 1);
  act(() => root.render(
    <ArgumentMapOverlay
      editor={editor}
      map={map}
      onSelect={vi.fn()}
      trace={[
        { quote: "a", reading: "Premise 1", sure: true, leads_to: null },
        { quote: "b", reading: "Competing point", sure: true, leads_to: null, role: "tensions" },
        { quote: "c", reading: "Web study", sure: false, leads_to: null, source: "e1" },
      ]}
    />,
  ));
  const arrows = [...scroll.querySelectorAll(".argument-map-arrow")];
  // Two note branches + one standalone off-page `web` root branch all converge on the diamond.
  expect(arrows).toHaveLength(3);
  expect(arrows[0].getAttribute("d")).not.toBe(arrows[1].getAttribute("d"));
  expect(arrows[1].getAttribute("data-role")).toBe("tensions");
  expect(arrows[1].hasAttribute("data-active")).toBe(true);
  expect(scroll.querySelector(".argument-map-via text")?.textContent).toBe("web");
});

it("draws parallel note and web branches converging into an intermediate synthesis step before the outcome", () => {
  const map = argumentMapFor({
    trace: [{ from: 2, to: 8 }, null, { from: 32, to: 38 }],
    source: { from: 61, to: 69 },
    provenance: [null, { kind: "web" }, null],
    offer: {
      trace: [
        { sure: true, leads_to: 3 },
        { sure: true, leads_to: 3 },
        { sure: true, leads_to: null },
      ],
    },
  }, 2);
  act(() => root.render(
    <ArgumentMapOverlay
      editor={editor}
      map={map}
      onSelect={vi.fn()}
      trace={[
        { quote: "a", reading: "Note passage", sure: true, leads_to: 3 },
        { quote: "b", reading: "Web source", sure: true, source: "e1", leads_to: 3 },
        { quote: "c", reading: "Synthesis claim", sure: true, leads_to: null },
      ]}
    />,
  ));
  // Step 1 -> Step 3, Web root -> Step 3, and Step 3 -> Outcome ♦ all render without forcing 1 -> 2 -> 3.
  expect(scroll.querySelectorAll(".argument-map-arrow")).toHaveLength(3);
  expect(scroll.querySelector(".argument-map-via text")?.textContent).toBe("web");
});
