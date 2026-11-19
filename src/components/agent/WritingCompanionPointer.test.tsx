// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WritingCompanionPointer } from "./WritingCompanionPointer";
import type { PreparedWritingOffer } from "../../lib/agent/writingOffers";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let editor: Editor;
let root: Root;
let area: HTMLDivElement;
let line: { top: number; bottom: number; left: number; right: number };
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let originRef: { current: HTMLDivElement };
let reducedMotion: boolean;
const cancelAnimation = vi.fn();
const animate = vi.fn();
const disconnect = vi.fn();
const pointer = () => document.querySelector<HTMLDivElement>(".writing-companion-pointer")!;

beforeEach(() => {
  frames = new Map();
  frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect = disconnect; });
  disconnect.mockClear();
  cancelAnimation.mockClear();
  animate.mockReset().mockImplementation(() => ({ cancel: cancelAnimation, onfinish: null }));
  reducedMotion = false;
  vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} }));
  originRef = { current: document.createElement("div") };
  document.body.append(originRef.current);
  vi.spyOn(originRef.current, "getClientRects").mockReturnValue([new DOMRect()] as unknown as DOMRectList);
  vi.spyOn(originRef.current, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 650, 40, 40));
  area = document.createElement("div");
  area.dataset.editorContentArea = "";
  document.body.append(area);
  editor = new Editor({ extensions: [StarterKit], content: "<p>A passage to review.</p>" });
  area.append(editor.view.dom);
  vi.spyOn(area, "getBoundingClientRect").mockReturnValue(new DOMRect(80, 100, 700, 500));
  vi.spyOn(editor.view.dom, "getBoundingClientRect").mockReturnValue(new DOMRect(140, 150, 600, 400));
  const block = editor.view.nodeDOM(0) as HTMLElement;
  vi.spyOn(block, "getBoundingClientRect").mockReturnValue(new DOMRect(160, 160, 560, 40));
  vi.spyOn(editor.view.dom, "getClientRects").mockReturnValue([new DOMRect()] as unknown as DOMRectList);
  vi.spyOn(block, "getClientRects").mockReturnValue([new DOMRect()] as unknown as DOMRectList);
  line = { top: 160, bottom: 180, left: 160, right: 160 };
  vi.spyOn(editor.view, "coordsAtPos").mockImplementation(() => line);
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function render(replayTrigger = 0) {
  act(() => root.render(<WritingCompanionPointer editor={editor} range={{ from: 0, to: 22 }} kind="evidence"
    originRef={originRef} replayTrigger={replayTrigger} />));
  pointer().animate = animate;
  flush();
}
function flush() {
  const callbacks = [...frames.values()];
  frames.clear();
  act(() => callbacks.forEach((callback) => callback(0)));
}

it("points from the prose gutter without changing the document or cursor", () => {
  const before = editor.getJSON();
  const selection = editor.state.selection.toJSON();
  render();
  expect(pointer().hidden).toBe(false);
  expect(Number.parseFloat(pointer().style.left) + Number.parseFloat(pointer().style.width)).toBeLessThan(140);
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(170);
  expect(pointer().getAttribute("aria-hidden")).toBe("true");
  expect(editor.getJSON()).toEqual(before);
  expect(editor.state.selection.toJSON()).toEqual(selection);
});

it("settles within the native editor's 24px gutter", () => {
  vi.mocked(area.getBoundingClientRect).mockReturnValue(new DOMRect(116, 100, 664, 500));
  render();
  expect(pointer().hidden).toBe(false);
  const left = Number.parseFloat(pointer().style.left);
  expect(left).toBeGreaterThanOrEqual(116);
  expect(left + Number.parseFloat(pointer().style.width)).toBeLessThan(140);
});

it("hides an offscreen paragraph instead of pointing at a different line", () => {
  render();
  line = { ...line, top: 80, bottom: 100 };
  window.dispatchEvent(new Event("scroll"));
  flush();
  expect(pointer().hidden).toBe(true);
  line = { ...line, top: 260, bottom: 280 };
  window.dispatchEvent(new Event("scroll"));
  flush();
  expect(pointer().hidden).toBe(false);
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(270);
});

it("hides when there is no free gutter and cleans up pending geometry updates", () => {
  vi.mocked(area.getBoundingClientRect).mockReturnValue(new DOMRect(140, 100, 640, 500));
  render();
  expect(pointer().hidden).toBe(true);
  window.dispatchEvent(new Event("resize"));
  expect(frames.size).toBe(1);
  act(() => root.render(null));
  expect(frames.size).toBe(0);
  expect(disconnect).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("scroll"));
  expect(frames.size).toBe(0);
});

it("uses the right gutter for right-to-left paragraphs", () => {
  (editor.view.nodeDOM(0) as HTMLElement).style.direction = "rtl";
  render();
  expect(pointer().hidden).toBe(false);
  expect(Number.parseFloat(pointer().style.left)).toBeGreaterThan(740);
  expect(pointer().dataset.direction).toBe("rtl");
});

it("travels from the companion and only replays on an explicit request", () => {
  render();
  const [keyframes, options] = animate.mock.calls[0];
  const source = originRef.current.getBoundingClientRect();
  const x = source.left + source.width / 2 - Number.parseFloat(pointer().style.left) - 10;
  const y = source.top + source.height / 2 - Number.parseFloat(pointer().style.top) - 10;
  expect(keyframes[0].transform).toBe(`translate(${x}px, ${y}px)`);
  expect(keyframes.at(-1).transform).toBe("translate(0px, 0px)");
  expect(options.duration).toBeGreaterThan(700);
  expect(pointer().dataset.motion).toBe("travelling");
  window.dispatchEvent(new Event("resize"));
  flush();
  expect(animate).toHaveBeenCalledOnce();
  render(1);
  expect(cancelAnimation).toHaveBeenCalledOnce();
  expect(animate).toHaveBeenCalledTimes(2);
});

it("cancels travel when scrolling changes the target and never chases stale coordinates", () => {
  render();
  line = { ...line, top: 200, bottom: 220 };
  window.dispatchEvent(new Event("scroll"));
  flush();
  expect(cancelAnimation).toHaveBeenCalledOnce();
  expect(pointer().dataset.motion).toBe("settled");
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(210);
  expect(animate).toHaveBeenCalledOnce();
});

it("respects reduced motion without moving the user's focus or selection", () => {
  reducedMotion = true;
  editor.view.dom.focus();
  const selection = editor.state.selection.toJSON();
  render();
  expect(pointer().hidden).toBe(false);
  expect(animate).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(editor.view.dom);
  expect(editor.state.selection.toJSON()).toEqual(selection);
});

function multiParagraphOffer(kind: "question" | "move"): PreparedWritingOffer {
  editor.commands.setContent("<p>First premise.</p><p>Missing connection.</p><p>Final conclusion.</p>");
  const blocks: { from: number; to: number }[] = [];
  editor.state.doc.forEach((node, from, index) => {
    blocks.push({ from, to: from + node.nodeSize });
    const element = editor.view.nodeDOM(from) as HTMLElement;
    vi.spyOn(element, "getClientRects").mockReturnValue([new DOMRect()] as unknown as DOMRectList);
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(160, 160 + index * 80, 560, 40));
  });
  vi.mocked(editor.view.coordsAtPos).mockImplementation((position) => {
    const index = blocks.findIndex((block) => position >= block.from && position < block.to);
    return { top: 160 + index * 80, bottom: 180 + index * 80, left: 160, right: 160 };
  });
  const sourceBlock = blocks[2];
  return { noteId: "note", documentSession: 1, source: sourceBlock, sourceBlock,
    destination: kind === "move" ? blocks[0] : null,
    trace: blocks.slice(0, 2), traceBlocks: blocks.slice(0, 2), provenance: [null, null],
    offer: kind === "move" ? { kind, quote: "Final conclusion.", explanation: "Lead with this.",
      destination: "First premise.", replacement: null, question: null, trace: [], sources: [] }
      : { kind, quote: "Final conclusion.", explanation: "The conclusion needs a connection.",
        question: "How does the premise establish this?", replacement: null, destination: null,
        trace: [{ quote: "First premise.", reading: "The premise.", sure: true },
          { quote: "Missing connection.", reading: "Then a jump.", sure: false }], sources: [] } };
}
function renderOffer(offer: PreparedWritingOffer, replayTrigger = 0, followTarget: PreparedWritingOffer["sourceBlock"] | null = null) {
  act(() => root.render(<WritingCompanionPointer editor={editor} range={offer.sourceBlock} kind="clarity"
    originRef={originRef} preparedOffer={offer} replayTrigger={replayTrigger} followTarget={followTarget} />));
  pointer().animate = animate;
  flush();
}
function finishLeg(index: number) {
  act(() => animate.mock.results[index].value.onfinish());
}

it("traces argument waypoints with a reading pause before settling at the question", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const offer = multiParagraphOffer("question");
  const before = editor.getJSON();
  renderOffer(offer);
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(170);
  finishLeg(0);
  expect(pointer().dataset.motion).toBe("reading");
  act(() => vi.advanceTimersByTime(279));
  expect(animate).toHaveBeenCalledOnce();
  act(() => vi.advanceTimersByTime(1));
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(250);
  finishLeg(1);
  act(() => vi.advanceTimersByTime(280));
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(330);
  finishLeg(2);
  expect(pointer().dataset.motion).toBe("settled");
  expect(editor.getJSON()).toEqual(before);
});

it("follows the map's active step from the opposite margin, hopping from step to step and staying put", () => {
  const offer = multiParagraphOffer("move");
  renderOffer(offer, 0, offer.traceBlocks[0]);
  // It flies in from the companion once, to the right of the text, flipped to point back at it.
  expect(animate).toHaveBeenCalledOnce();
  expect(animate.mock.calls[0][1]).toMatchObject({ duration: 1100 });
  expect(Number.parseFloat(pointer().style.left)).toBeGreaterThanOrEqual(740);
  expect(pointer().dataset.direction).toBe("rtl");
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(170);
  finishLeg(0);
  expect(pointer().dataset.motion).toBe("settled");
  // The next step is a short hop from where it rests, not another flight from the panel.
  renderOffer(offer, 0, offer.traceBlocks[1]);
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.calls[1][1]).toMatchObject({ duration: 620 });
  const [first] = animate.mock.calls[1][0] as Keyframe[];
  expect(first.transform).toBe("translate(0px, -80px)");
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(250);
  finishLeg(1);
  expect(pointer().hidden).toBe(false);
  expect(pointer().querySelector(".writing-companion-pointer-ghost")).toBeNull();
});

it("picks up a paragraph ghost and previews an earlier position entirely in the gutter", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const offer = multiParagraphOffer("move");
  vi.mocked(area.getBoundingClientRect).mockReturnValue(new DOMRect(116, 100, 664, 500));
  const before = editor.getJSON();
  const selection = editor.state.selection.toJSON();
  renderOffer(offer);
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(330);
  expect(pointer().dataset.carry).toBe("false");
  finishLeg(0);
  act(() => vi.advanceTimersByTime(280));
  expect(pointer().dataset.carry).toBe("true");
  expect(pointer().querySelector(".writing-companion-pointer-ghost-excerpt")?.textContent).toBe("Final conclusion.");
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(170);
  expect(pointer().dataset.ghostSize).toBe("compact");
  const width = Number(pointer().style.getPropertyValue("--ghost-scale")) * 48;
  expect(Number.parseFloat(pointer().style.left) + 20 - width).toBeGreaterThanOrEqual(116);
  expect(Number.parseFloat(pointer().style.left) + 20).toBeLessThan(140);
  finishLeg(1);
  expect(pointer().dataset.motion).toBe("settled");
  expect(editor.getJSON()).toEqual(before);
  expect(editor.state.selection.toJSON()).toEqual(selection);
});

it("cancels the remaining tour on scroll and anchors the final passage", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  renderOffer(multiParagraphOffer("question"));
  finishLeg(0);
  window.dispatchEvent(new Event("scroll"));
  flush();
  act(() => vi.advanceTimersByTime(2000));
  expect(animate).toHaveBeenCalledOnce();
  expect(pointer().dataset.motion).toBe("settled");
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(330);
});

it("cleans up a reading pause and skips the whole move tour for reduced motion", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  renderOffer(multiParagraphOffer("question"));
  finishLeg(0);
  act(() => root.render(null));
  act(() => vi.advanceTimersByTime(2000));
  expect(animate).toHaveBeenCalledOnce();
  reducedMotion = true;
  renderOffer(multiParagraphOffer("move"));
  expect(animate).toHaveBeenCalledOnce();
  expect(pointer().dataset.motion).toBe("settled");
  expect(pointer().dataset.carry).toBe("false");
  expect(pointer().dataset.offerKind).toBe("move");
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(170);
});


it("keeps a refreshed offer settled after unrelated typing and only repeats on explicit replay", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const offer = multiParagraphOffer("question");
  renderOffer(offer);
  finishLeg(0);
  editor.commands.insertContentAt(editor.state.doc.content.size, "<p>A new thought.</p>");
  // The provider returns a fresh prepared object for every document transaction.
  const refreshed = { ...offer, offer: { ...offer.offer }, sourceBlock: { ...offer.sourceBlock } };
  renderOffer(refreshed);
  act(() => vi.advanceTimersByTime(1000));
  expect(animate).toHaveBeenCalledOnce();
  expect(pointer().dataset.motion).toBe("settled");
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(330);
  expect(editor.getText()).toContain("A new thought.");
  renderOffer(refreshed, 1);
  expect(animate).toHaveBeenCalledTimes(2);
  expect(Number.parseFloat(pointer().style.top) + 2).toBe(170);
});


it("labels a roomy move preview, fades it after landing, and restores it on replay", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const offer = multiParagraphOffer("move");
  vi.mocked(area.getBoundingClientRect).mockReturnValue(new DOMRect(0, 100, 780, 500));
  renderOffer(offer);
  finishLeg(0);
  act(() => vi.advanceTimersByTime(280));
  expect(pointer().dataset.ghostSize).toBe("full");
  expect(pointer().querySelector(".writing-companion-pointer-ghost-label")?.textContent).toBe("Move preview");
  expect(pointer().dataset.carry).toBe("true");
  finishLeg(1);
  act(() => vi.advanceTimersByTime(899));
  expect(pointer().dataset.carry).toBe("true");
  act(() => vi.advanceTimersByTime(1));
  expect(pointer().dataset.carry).toBe("false");
  expect(pointer().dataset.offerKind).toBe("move");
  expect(pointer().dataset.motion).toBe("settled");
  renderOffer(offer, 1);
  finishLeg(2);
  act(() => vi.advanceTimersByTime(280));
  expect(pointer().dataset.carry).toBe("true");
  finishLeg(3);
  const detachedPointer = pointer();
  act(() => root.render(null));
  // Cleanup hides the ghost and cancels its landing timer.
  detachedPointer.dataset.carry = "sentinel";
  act(() => vi.advanceTimersByTime(1000));
  expect(detachedPointer.dataset.carry).toBe("sentinel");
});

it("clears a carried move preview immediately when the writer scrolls", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  renderOffer(multiParagraphOffer("move"));
  finishLeg(0);
  act(() => vi.advanceTimersByTime(280));
  expect(pointer().dataset.carry).toBe("true");
  finishLeg(1);
  window.dispatchEvent(new Event("scroll"));
  flush();
  expect(pointer().dataset.carry).toBe("false");
  expect(pointer().dataset.motion).toBe("settled");
  act(() => vi.advanceTimersByTime(1000));
  expect(animate).toHaveBeenCalledTimes(2);
});
