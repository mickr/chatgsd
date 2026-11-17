// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WritingOffer, PreparedWritingOffer } from "../../lib/agent/writingOffers";
import { renderableSpec } from "../../lib/agent/ui/content";
import { WritingOfferCard, WritingOfferContext, type WritingOfferControls } from "./WritingOfferCard";
import { AgentSpec } from "./ui/AgentSpec";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let container: HTMLDivElement;
let reducedMotion = true;
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 1;

const base = { quote: "The draft makes a leap.", explanation: "Make the connection concrete.",
  replacement: null, question: null, destination: null, trace: [], sources: [] };
const rewrite: WritingOffer = { ...base, kind: "rewrite", replacement: "A clearer connection." };
function controls(offer: WritingOffer = rewrite): WritingOfferControls {
  const prepared: PreparedWritingOffer = { offer, noteId: "note", documentSession: 1,
    source: { from: 1, to: 24 }, sourceBlock: { from: 0, to: 25 }, destination: null,
    trace: [], traceBlocks: [] };
  return { id: "writing-1", offer: prepared, stale: false, busy: false,
    onAccept: vi.fn(), onAnswer: vi.fn(), onShow: vi.fn(), onDismiss: vi.fn(), onAddToChat: vi.fn() };
}
const render = (props: WritingOfferControls) => act(() => root.render(<WritingOfferCard {...props} />));
const button = (label: string) => [...container.querySelectorAll("button")]
  .find(item => item.textContent?.trim() === label)!;
const click = (label: string) => act(() => button(label).click());
function type(value: string) {
  const textarea = container.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function frame(time: number) {
  const pending = [...frames.values()];
  frames.clear();
  act(() => pending.forEach(callback => callback(time)));
}

beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  reducedMotion = true;
  frames = new Map();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reducedMotion,
    addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame++; frames.set(id, callback); return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  invoke.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("keeps an edited rewrite across unrelated updates and applies only on acceptance", () => {
  const props = controls();
  render(props);
  expect(props.onAccept).not.toHaveBeenCalled();
  click("Edit proposal");
  type("My own clearer version.");
  render({ ...props, offer: { ...props.offer } });
  expect(container.querySelector("textarea")!.value).toBe("My own clearer version.");
  click("Accept rewrite");
  expect(props.onAccept).toHaveBeenCalledExactlyOnceWith("My own clearer version.");
});

it("supports a shared controlled draft when moving between companion surfaces", () => {
  const props = { ...controls(), draft: "Shared wording", onDraftChange: vi.fn() };
  render(props);
  click("Edit proposal");
  type("Writer's update");
  expect(props.onDraftChange).toHaveBeenCalledExactlyOnceWith("Writer's update");
  act(() => root.render(null));
  render({ ...props, draft: "Writer's update" });
  expect(container.querySelector('[aria-label="Proposed wording"]')!.textContent).toBe("Writer's update");
  click("Accept rewrite");
  expect(props.onAccept).toHaveBeenCalledExactlyOnceWith("Writer's update");
});

it("reveals whole graphemes quickly, keeps progress on rerender, and stops when editing", () => {
  reducedMotion = false;
  const props = controls({ ...rewrite, replacement: "👩🏽‍💻é" });
  render(props);
  const preview = () => container.querySelector('[aria-label="Proposed wording"]')!.textContent;
  frame(0);
  frame(100);
  expect(preview()).toBe("👩🏽‍💻");
  render({ ...props });
  expect(preview()).toBe("👩🏽‍💻");
  click("Edit proposal");
  expect(container.querySelector("textarea")!.value).toBe("👩🏽‍💻é");
  expect(frames.size).toBe(0);
});

it("respects reduced motion and allows accepting the full proposal during reveal", () => {
  const props = controls();
  render(props);
  expect(container.querySelector('[aria-label="Proposed wording"]')!.textContent).toBe(rewrite.replacement);
  expect(frames.size).toBe(0);
  reducedMotion = false;
  render({ ...props, id: "writing-2" });
  expect(frames.size).toBe(1);
  click("Accept rewrite");
  expect(props.onAccept).toHaveBeenCalledExactlyOnceWith(rewrite.replacement);
});

it("asks one question and sends the answer only after explicit submission", () => {
  const props = controls({ ...base, kind: "question", question: "What makes that consequence follow?" });
  render(props);
  expect(button("Send answer").disabled).toBe(true);
  type("  Because the incentives changed.  ");
  expect(props.onAnswer).not.toHaveBeenCalled();
  click("Trace argument");
  expect(props.onShow).toHaveBeenCalledOnce();
  click("Send answer");
  expect(props.onAnswer).toHaveBeenCalledExactlyOnceWith("Because the incentives changed.");
});

it("Add to chat only hands context to the composer callback", () => {
  const props = controls();
  render(props);
  click("Add to chat");
  expect(props.onAddToChat).toHaveBeenCalledOnce();
  expect(props.onAccept).not.toHaveBeenCalled();
  expect(props.onAnswer).not.toHaveBeenCalled();
  click("Dismiss");
  expect(props.onDismiss).toHaveBeenCalledOnce();
});

it("preserves a stale draft but prevents rewrite acceptance and question submission", () => {
  const props = controls();
  render(props);
  click("Edit proposal");
  type("Keep this draft.");
  render({ ...props, stale: true });
  expect(container.querySelector("textarea")!.value).toBe("Keep this draft.");
  expect(container.querySelector('[role="status"]')!.textContent).toContain("passage changed");
  click("Accept rewrite");
  expect(props.onAccept).not.toHaveBeenCalled();
  expect(button("Show passage").disabled).toBe(true);
  const question = controls({ ...base, kind: "question", question: "Why?" });
  render({ ...question, id: "question", draft: "My answer", stale: true });
  act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(question.onAnswer).not.toHaveBeenCalled();
});

it("previews a paragraph move without applying it until requested", () => {
  const props = controls({ ...base, kind: "move", destination: "Introduce the premise first." });
  render(props);
  expect(container.querySelector(".writing-offer-ghost")!.textContent).toContain(base.quote);
  expect(container.querySelector(".writing-offer-destination")!.textContent).toBe("Introduce the premise first.");
  click("Preview move");
  expect(props.onShow).toHaveBeenCalledOnce();
  expect(props.onAccept).not.toHaveBeenCalled();
  render({ ...props, busy: true });
  click("Apply move");
  expect(props.onAccept).not.toHaveBeenCalled();
  render(props);
  click("Apply move");
  expect(props.onAccept).toHaveBeenCalledExactlyOnceWith();
});

it("opens safe sources through the existing opener and never activates unsafe URLs", async () => {
  const props = controls({ ...base, kind: "evidence", sources: [
    { title: "Study", url: "https://example.com/study", excerpt: "The study qualifies this claim." },
    { title: "<script>unsafe</script>", url: "javascript:alert(1)", excerpt: "Not an executable link." },
    { title: "Credentials", url: "https://secret@example.com", excerpt: "Not an executable link." },
  ] });
  render({ ...props, stale: true });
  expect(container.querySelectorAll("a")).toHaveLength(1);
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toContain("<script>unsafe</script>");
  await act(async () => container.querySelector("a")!.click());
  expect(invoke).toHaveBeenCalledExactlyOnceWith("open_url_safe", { url: "https://example.com/study" });
});

it("does not manufacture editor actions for an unbound or invented model-authored id", () => {
  const props = controls();
  const spec = { root: "offer", elements: { offer: { type: "WritingSuggestion", props: { id: "invented" }, children: [] } } };
  act(() => root.render(<WritingOfferContext.Provider value={props}><AgentSpec spec={spec} /></WritingOfferContext.Provider>));
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(props.onAccept).not.toHaveBeenCalled();
  act(() => root.render(<AgentSpec spec={spec} />));
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

it("accepts the shared card in assistant specs without coercing malformed offer references", () => {
  const spec = { root: "offer", elements: { offer: { type: "WritingSuggestion", props: { id: "writing-1" }, children: [] } } };
  expect(renderableSpec(spec)).not.toBeNull();
  const malformed = { ...spec, elements: { offer: { ...spec.elements.offer, props: { id: 42 } } } };
  act(() => root.render(<WritingOfferContext.Provider value={{ ...controls(), id: "42" }}>
    <AgentSpec spec={malformed} />
  </WritingOfferContext.Provider>));
  expect(container.querySelectorAll("button")).toHaveLength(0);
});
