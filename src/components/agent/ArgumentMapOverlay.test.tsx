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
  render({ steps: [{ from: 2, to: 8, sure: true, index: 0, via: [] }, { from: 42, to: 48, sure: false, index: 2, via: ["web"] }],
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
  // A node carries its step's place in the whole trace, the number the panel and the agent use for it.
  expect([...scroll.querySelectorAll(".argument-map-node text")].map(text => text.textContent)).toEqual(["1", "3"]);
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
  expect(scroll.querySelector(".argument-map-via text")?.textContent).toBe("3 web");
  expect(scroll.querySelector(".argument-map-via")?.hasAttribute("data-unsure")).toBe(true);
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
  expect(scroll.querySelector(".argument-map-via text")?.textContent).toBe("2 web");
});

const offPageChain = () => argumentMapFor({
  trace: [{ from: 2, to: 8 }, null, null, { from: 62, to: 68 }],
  source: { from: 91, to: 99 },
  provenance: [null, { kind: "web" }, { kind: "service" }, null],
  offer: { trace: [{ sure: true }, { sure: true }, { sure: true }, { sure: true }] },
}, 2);
const chainTrace = [
  { quote: "a", reading: "Note passage", sure: true },
  { quote: "b", reading: "What the study found", sure: true, source: "e1" },
  { quote: "c", reading: "What the archive holds", sure: true, source: "e2" },
  { quote: "d", reading: "Where they meet", sure: true },
];

it("gives every step outside the note its own numbered pill that opens that step", () => {
  const onSelect = vi.fn();
  act(() => root.render(<ArgumentMapOverlay editor={editor} map={offPageChain()} onSelect={onSelect} trace={chainTrace} />));
  const pills = [...scroll.querySelectorAll<SVGGElement>(".argument-map-via")];
  // Two conversation steps on one arrow are two pills, not one pill and a plus sign.
  expect(pills.map(pill => pill.querySelector("text")?.textContent)).toEqual(["2 web", "3 mcp"]);
  expect(pills.map(pill => pill.querySelector("title")?.textContent)).toEqual([
    "Web research: What the study found", "Connected service: What the archive holds"]);
  expect(pills.map(pill => pill.hasAttribute("data-active"))).toEqual([false, true]);
  act(() => pills[1].dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(2);
  // They sit apart along the arrow, in the order the branch read them.
  const y = (pill: SVGGElement) => Number(/translate\(\S+ (\S+)\)/.exec(pill.getAttribute("transform")!)![1]);
  expect(y(pills[1]) - y(pills[0])).toBe(14);
});

it("shows a leading conversation step on a single-thread map, so the numbering has no silent gap", () => {
  const map = argumentMapFor({
    trace: [null, { from: 22, to: 28 }], source: { from: 61, to: 69 },
    provenance: [{ kind: "you" }, null], offer: { trace: [{ sure: true }, { sure: true }] },
  }, null);
  act(() => root.render(<ArgumentMapOverlay editor={editor} map={map} onSelect={vi.fn()}
    trace={[{ quote: "a", reading: "You asked", sure: true, source: "e1" }, { quote: "b", reading: "So", sure: true }]} />));
  expect(scroll.querySelector(".argument-map-via text")?.textContent).toBe("1 you");
  expect(scroll.querySelector(".argument-map-node text")?.textContent).toBe("2");
});

it("asks the text for a gutter when the margin is too narrow to draw in, and keeps branches apart there", () => {
  // The prose starts 8px from the edge of the note: the window is narrow or the panel is wide.
  (editor.view.dom as HTMLElement).getBoundingClientRect = () => new DOMRect(8, 0, 600, 2000);
  const map = argumentMapFor({
    trace: [{ from: 2, to: 8 }, { from: 12, to: 18 }, { from: 22, to: 28 }],
    source: { from: 191, to: 199 }, provenance: [null, null, null],
    offer: { trace: [{ sure: true, leads_to: null }, { sure: true, leads_to: null }, { sure: true, leads_to: null }] },
  }, null);
  act(() => root.render(<ArgumentMapOverlay editor={editor} map={map} onSelect={vi.fn()} trace={chainTrace.slice(0, 3)} />));
  expect(scroll.dataset.argumentMapGutter).toBe("left");
  act(() => root.render(null));
  expect(scroll.dataset.argumentMapGutter).toBeUndefined();

  // With the gutter in place there is 42px of margin. Three long nested arcs would each want more bow than
  // that, and still keep a lane of their own instead of flattening onto the margin's edge.
  (editor.view.dom as HTMLElement).getBoundingClientRect = () => new DOMRect(56, 0, 600, 2000);
  act(() => root.render(<ArgumentMapOverlay editor={editor} map={map} onSelect={vi.fn()} trace={chainTrace.slice(0, 3)} />));
  const bows = [...scroll.querySelectorAll(".argument-map-arrow")]
    .map(arrow => Number(/C (\S+) /.exec(arrow.getAttribute("d")!)![1]));
  expect(new Set(bows).size).toBe(3);
  expect(Math.min(...bows)).toBeGreaterThanOrEqual(2 + 8);
});

it("asks for the gutter once while the map is open, and never after it has closed", async () => {
  (editor.view.dom as HTMLElement).getBoundingClientRect = () => new DOMRect(8, 0, 600, 2000);
  let fontsLoaded!: () => void;
  Object.defineProperty(document, "fonts", { configurable: true,
    value: { ready: new Promise<void>(resolve => { fontsLoaded = resolve; }) } });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const map = (active: number): ArgumentMapState => ({ steps: [{ from: 2, to: 8, sure: true, index: 0, via: [] }],
    decision: { from: 61, to: 69, via: [] }, active, length: 1 });
  let changes = 0;
  const observer = new MutationObserver(records => { changes += records.length; });
  observer.observe(scroll, { attributes: true, attributeFilter: ["data-argument-map-gutter"] });

  render(map(0));
  // Each step of playback is a new map. Taking the gutter away and putting it back would reflow the note every time.
  render(map(1));
  expect(scroll.querySelector(".argument-map-node[data-active]")?.hasAttribute("data-decision")).toBe(true);
  changes += observer.takeRecords().length;
  expect(changes).toBe(1);

  // Fonts that finish loading after the map has closed must not leave the note indented.
  act(() => root.render(null));
  fontsLoaded();
  await Promise.resolve();
  await Promise.resolve();
  for (const callback of frames.splice(0)) callback(0);
  expect(scroll.dataset.argumentMapGutter).toBeUndefined();
  observer.disconnect();
  Reflect.deleteProperty(document, "fonts");
});
