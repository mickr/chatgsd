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
    trace: [], traceBlocks: [], provenance: offer.trace.map(() => null) };
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
  click("Show passage");
  expect(props.onShow).toHaveBeenCalledOnce();
  click("Send answer");
  expect(props.onAnswer).toHaveBeenCalledExactlyOnceWith("Because the incentives changed.");
});

it("sends a question's answer with Cmd+Enter and keeps plain Enter for a new line", () => {
  const props = controls({ ...base, kind: "question", question: "Why does this follow?" });
  render(props);
  type("Because the costs changed.");
  const textarea = container.querySelector("textarea")!;
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
    act(() => { textarea.dispatchEvent(event); });
    return event;
  };
  expect(press({}).defaultPrevented).toBe(false);
  expect(props.onAnswer).not.toHaveBeenCalled();
  expect(press({ metaKey: true }).defaultPrevented).toBe(true);
  expect(props.onAnswer).toHaveBeenCalledExactlyOnceWith("Because the costs changed.");
});

it("answers a question with one click on a suggested answer, unless the passage has changed", () => {
  const offer: WritingOffer = { ...base, kind: "question", question: "Why does this follow?", options: ["It's deliberate", "Cut it"] };
  const props = controls(offer);
  render(props);
  click("Cut it");
  expect(props.onAnswer).toHaveBeenCalledExactlyOnceWith("Cut it");
  const stale = { ...controls(offer), stale: true };
  render(stale);
  expect(button("Cut it").disabled).toBe(true);
  click("Cut it");
  expect(stale.onAnswer).not.toHaveBeenCalled();
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

it("maps how the agent got to an offer and sends a correction to the step it misread", () => {
  const traced: WritingOffer = { ...rewrite, trace: [
    { quote: "The premise.", reading: "You start from the premise.", sure: true },
    { quote: "The leap.", reading: "I took this as a cause.", sure: false },
  ] };
  const map = { open: false, active: null, onToggle: vi.fn(), onFocus: vi.fn(), onRealign: vi.fn() };
  const props = { ...controls(traced), map };
  render(props);
  expect(container.querySelector(".argument-map-steps")).toBeNull();
  click("How I got here");
  expect(map.onToggle).toHaveBeenCalledOnce();
  render({ ...props, map: { ...map, open: true, active: 1 } });
  const steps = [...container.querySelectorAll(".argument-map-steps > li")];
  expect(steps).toHaveLength(3);
  expect(steps[1].hasAttribute("data-unsure")).toBe(true);
  expect(steps[1].hasAttribute("data-active")).toBe(true);
  expect(steps[1].textContent).toContain("I assumed this");
  expect(steps[2].textContent).toContain("So: Make the connection concrete.");
  act(() => steps[2].querySelector("button")!.click());
  expect(map.onFocus).toHaveBeenCalledWith(2);
  act(() => (steps[1].querySelector(".argument-map-steps-realign") as HTMLButtonElement).click());
  expect(button("Re-think from here").disabled).toBe(true);
  type("It's a correlation, not a cause.");
  click("Re-think from here");
  expect(map.onRealign).toHaveBeenCalledExactlyOnceWith(1, "It's a correlation, not a cause.");
  expect(props.onAccept).not.toHaveBeenCalled();
});

it("offers no map when the agent recorded no reasoning", () => {
  render({ ...controls(), map: { open: false, active: null, onToggle: vi.fn(), onFocus: vi.fn(), onRealign: vi.fn() } });
  expect(button("How I got here")).toBeUndefined();
});

it("ends an outcome trace on the whole highlight and names the sentence the question is about", () => {
  const question: WritingOffer = { ...base, kind: "question", question: "Is this a packing aid?",
    quote: "Something to sit on if we want it.", explanation: "The opening edit set the tone.",
    trace: [{ quote: "Bring a blanket.", reading: "You started with comfort.", sure: true }] };
  const props = controls(question);
  const map = { open: true, active: 1, onToggle: vi.fn(), onFocus: vi.fn(), onRealign: vi.fn() };
  render({ ...props, map, offer: { ...props.offer, requested: "outcome",
    outcome: { from: 0, to: 80, text: "Bring a blanket.\nSomething to sit on if we want it.", paragraphs: 2 } } });
  const rows = container.querySelectorAll(".argument-map-steps > li");
  const last = rows[rows.length - 1];
  expect(last.textContent).toContain("Your highlight · 2 paragraphs");
  expect(last.querySelector(".argument-map-steps-outcome")?.textContent).toBe("Bring a blanket.\nSomething to sit on if we want it.");
  expect(last.textContent).toContain("What we learned: The opening edit set the tone.");
  expect(last.querySelector(".argument-map-steps-focus")?.textContent).toBe("Something to sit on if we want it.");
  expect(last.textContent).toContain("Is this a packing aid?");
  act(() => (last.querySelector(".argument-map-steps-focus") as HTMLButtonElement).click());
  expect(map.onFocus).toHaveBeenCalledWith(1);
});

it("connects the card to its passage: the quote takes you there, and looking at the card tints it", () => {
  const props = { ...controls({ ...base, kind: "question", question: "What should the diagram show?" }), onHighlight: vi.fn() };
  render(props);
  const card = container.querySelector(".writing-offer-card")!;
  act(() => { card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); });
  expect(props.onHighlight).toHaveBeenLastCalledWith(true);
  const passage = container.querySelector<HTMLButtonElement>(".writing-offer-passage")!;
  expect(passage.textContent).toContain(base.quote);
  act(() => passage.click());
  expect(props.onShow).toHaveBeenCalledOnce();
  act(() => { card.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
  expect(props.onHighlight).toHaveBeenLastCalledWith(false);
  render({ ...props, stale: true });
  expect(container.querySelector<HTMLButtonElement>(".writing-offer-passage")!.disabled).toBe(true);
});

it("renders a dynamic GenUI convergent branch layout with thread filters and honours safe custom views", () => {
  const convergent: WritingOffer = {
    ...rewrite,
    trace: [
      { quote: "Premise one.", reading: "Supports the claim.", sure: true, leads_to: null },
      { quote: "Web counterpoint.", reading: "Qualifies the scope.", sure: false, source: "e1", leads_to: null, role: "tensions" },
    ],
  };
  const map = { open: true, active: 0, onToggle: vi.fn(), onFocus: vi.fn(), onRealign: vi.fn() };
  const baseProps = controls(convergent);
  render({
    ...baseProps,
    map,
    offer: {
      ...baseProps.offer,
      trace: [{ from: 1, to: 10 }, null],
      provenance: [null, { id: "e1", kind: "web", label: "Research: scope", text: "Web counterpoint." }],
    },
  });
  expect(container.querySelector(".argument-map-genui")).not.toBeNull();
  expect(container.textContent).toContain("Premise 1 → Outcome");
  expect(container.textContent).toContain("Tension · Counterpoint → Outcome");
  expect(container.querySelectorAll(".argument-map-step-row")).toHaveLength(3);

  // Clicking a thread pill focuses that branch in the margin and filters the GenUI view.
  click("Tension · #2");
  expect(map.onFocus).toHaveBeenCalledWith(1);
  expect(container.querySelectorAll(".argument-map-step-row")).toHaveLength(2);
  click("All threads (2)");
  expect(container.querySelectorAll(".argument-map-step-row")).toHaveLength(3);

  // A custom model-authored view cannot hide omitted steps or the outcome.
  const withCustomView: WritingOffer = {
    ...convergent,
    view: {
      root: "custom",
      elements: {
        custom: { type: "Card", props: { title: "Custom synthesis" }, children: ["s1"] },
        s1: { type: "TraceStep", props: { offerId: null, step: 1 }, children: [] },
      },
    } as WritingOffer["view"],
  };
  const customProps = controls(withCustomView);
  render({
    ...customProps,
    map,
    offer: {
      ...customProps.offer,
      trace: [{ from: 1, to: 10 }, null],
      provenance: [null, { id: "e1", kind: "web", label: "Research: scope", text: "Web counterpoint." }],
    },
  });
  expect(container.textContent).toContain("Custom synthesis");
  // Step 2 and TraceOutcome were omitted by the spec and automatically appended!
  expect(container.querySelectorAll(".argument-map-step-row")).toHaveLength(3);
});

it("surfaces 1-click clarifications on unsure assumptions both on the collapsed card and inside the open trace", () => {
  const traced: WritingOffer = {
    ...rewrite,
    trace: [
      { quote: "The premise.", reading: "You start from the premise.", sure: true },
      { quote: "The leap.", reading: "I took this as a causal claim.", sure: false },
    ],
  };
  const onToggle = vi.fn();
  const onFocus = vi.fn();
  const onConfirm = vi.fn();
  const onCheckSource = vi.fn();
  const onRealign = vi.fn();
  const baseProps = controls(traced);

  // When the map is closed, the card surfaces the unsure assumption with 1-click Confirm / Correct / Check a source.
  render({
    ...baseProps,
    map: { open: false, active: null, onToggle, onFocus, onRealign, onConfirm, onCheckSource },
  });
  const callout = container.querySelector('[aria-label="Unverified assumption"]');
  expect(callout).not.toBeNull();
  expect(callout!.textContent).toContain("I assumed this · I took this as a causal claim.");
  click("Confirm assumption");
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith(1);
  click("Check a source");
  expect(onCheckSource).toHaveBeenCalledExactlyOnceWith(1);

  // Clicking "Correct it" from the collapsed callout opens the map focused on that step with the correction box open.
  click("Correct it");
  expect(onToggle).toHaveBeenCalledOnce();
  expect(onFocus).toHaveBeenCalledWith(1);
  render({
    ...baseProps,
    map: { open: true, active: 1, onToggle, onFocus, onRealign, onConfirm, onCheckSource },
  });
  expect(container.querySelector('[aria-label="What you meant at step 2"]')).not.toBeNull();

  // An earlier turn may have answered step 1, and the writer confirmed step 2. Only the confirmation settles a step:
  // the earlier answer is put beside the assumption for the writer to judge.
  const settled: WritingOffer = {
    ...rewrite,
    trace: [
      { quote: "The premise.", reading: "Taken from your answer.", sure: false },
      { quote: "The leap.", reading: "Confirmed causal link.", sure: true },
    ],
  };
  const settledProps = controls(settled);
  render({
    ...settledProps,
    id: "writing-settled",
    map: { open: true, active: 0, onToggle, onFocus, onRealign, onConfirm, onCheckSource },
    offer: {
      ...settledProps.offer,
      resolved: [{ id: "e1", kind: "you", label: "Answered: Why?", text: "Because of the incentive shift." }, null],
      confirmedSteps: [false, true],
    },
  });
  const rows = container.querySelectorAll(".argument-map-steps > li");
  expect(rows[0].textContent).toContain("I assumed this · Taken from your answer.");
  expect(rows[0].textContent).toContain("You may have answered this already");
  expect(rows[0].hasAttribute("data-unsure")).toBe(true);
  act(() => [...rows[0].querySelectorAll("button")].find(item => item.textContent === "Show earlier answer")!.click());
  expect(rows[0].querySelector("pre")?.textContent).toBe("Because of the incentive shift.");
  act(() => (rows[0].querySelector(".argument-map-steps-confirm") as HTMLButtonElement).click());
  expect(onConfirm).toHaveBeenLastCalledWith(0);
  expect(rows[1].textContent).toContain("Confirmed · Confirmed causal link.");
  expect(rows[1].textContent).not.toContain("You may have answered");
});

it("numbers every step by its place in the trace, and says when the writer has changed or cut a step's passage", () => {
  const traced: WritingOffer = { ...rewrite, trace: [
    { quote: "Bring a rug", reading: "You asked for comfort.", sure: true, source: "e1" },
    { quote: "The premise.", reading: "You start here.", sure: true },
    { quote: "The leap.", reading: "Then you jump.", sure: true },
  ] };
  const map = { open: true, active: null, onToggle: vi.fn(), onFocus: vi.fn(), onRealign: vi.fn() };
  const props = controls(traced);
  render({ ...props, map, offer: { ...props.offer,
    trace: [null, { from: 1, to: 10 }, null], edited: [false, true, true],
    provenance: [{ id: "e1", kind: "you", label: "You said", text: "Bring a rug" }, null, null] } });
  const rows = [...container.querySelectorAll(".argument-map-steps > li")];
  // The conversation step is step 1 here, as it is for the agent and in the margin: no blank, no renumbering.
  expect(rows.slice(0, 3).map(row => row.querySelector(".argument-map-steps-number")?.textContent)).toEqual(["1", "2", "3"]);
  expect(rows[1].textContent).toContain("You've changed this since");
  expect(rows[1].querySelector("button.argument-map-steps-quote")?.getAttribute("aria-label")).toBe("Show step 2 in the note");
  // A cut passage has nowhere to go and no conversation to show: it is quoted, and said to be gone.
  expect(rows[2].textContent).toContain("No longer in the note");
  expect(rows[2].querySelector("blockquote")?.textContent).toBe("The leap.");
  expect([...rows[2].querySelectorAll("button")].map(item => item.textContent)).toEqual(["Not what I meant"]);
  act(() => (rows[2].querySelector(".argument-map-steps-realign") as HTMLButtonElement).click());
  expect(container.querySelector('[aria-label="What you meant at step 3"]')).not.toBeNull();
});

it("pauses and resumes the map's playback, and steps through it with the arrow keys", () => {
  const traced: WritingOffer = { ...rewrite, trace: [
    { quote: "The premise.", reading: "You start here.", sure: true },
    { quote: "The leap.", reading: "Then you jump.", sure: true },
  ] };
  const map = { open: true, active: 0, playing: true, onPlay: vi.fn(), onToggle: vi.fn(), onFocus: vi.fn(), onRealign: vi.fn() };
  const props = controls(traced);
  const offer = { ...props.offer, trace: [{ from: 1, to: 10 }, { from: 12, to: 20 }] };
  render({ ...props, offer, map });
  click("Pause");
  expect(map.onPlay).toHaveBeenCalledOnce();
  render({ ...props, offer, map: { ...map, playing: false } });
  expect(button("Play through")).toBeDefined();

  const press = (target: Element, key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  const rows = [...container.querySelectorAll(".argument-map-steps > li")];
  expect(press(rows[0].querySelector("button")!, "ArrowDown")).toBe(true);
  expect(map.onFocus).toHaveBeenLastCalledWith(1);
  // The keyboard goes with it, so the next press carries on from there.
  expect(document.activeElement).toBe(rows[1].querySelector("button"));
  render({ ...props, offer, map: { ...map, playing: false, active: 1 } });
  press(document.activeElement!, "ArrowDown");
  expect(map.onFocus).toHaveBeenLastCalledWith(2);
  render({ ...props, offer, map: { ...map, playing: false, active: 2 } });
  press(document.activeElement!, "ArrowDown");
  expect(map.onFocus).toHaveBeenLastCalledWith(2);
  press(document.activeElement!, "ArrowUp");
  expect(map.onFocus).toHaveBeenLastCalledWith(1);

  // Arrows inside the correction box move the caret, not the map.
  act(() => (rows[0].querySelector(".argument-map-steps-realign") as HTMLButtonElement).click());
  map.onFocus.mockClear();
  expect(press(container.querySelector("textarea")!, "ArrowDown")).toBe(false);
  expect(map.onFocus).not.toHaveBeenCalled();
});

it("does not offer to confirm an assumption about words the note no longer has, and shows an answer already given", () => {
  const question: WritingOffer = { ...base, kind: "question", question: "Which launch?", trace: [
    { quote: "It ships soon.", reading: "I took soon to mean this quarter.", sure: false },
    { quote: "The plan holds.", reading: "I took the plan to be the launch plan.", sure: false },
  ] };
  const map = { open: true, active: null, onToggle: vi.fn(), onFocus: vi.fn(), onRealign: vi.fn(), onConfirm: vi.fn() };
  const props = controls(question);
  const offer = { ...props.offer, trace: [{ from: 1, to: 10 }, { from: 12, to: 20 }], edited: [true, false], answered: "The spring one." };
  render({ ...props, map, offer });
  const rows = [...container.querySelectorAll(".argument-map-steps > li[data-trace-step]")];
  const actions = (row: Element) => [...row.querySelectorAll(".argument-map-steps-actions button")].map(item => item.textContent);
  // The reading was of the quoted words. Confirming it now would save a meaning for a sentence that isn't there.
  expect(actions(rows[0])).toEqual(["Correct it"]);
  expect(actions(rows[1])).toEqual(["Confirm assumption", "Correct it"]);
  // These are the rows the open card is reading, which is how the panel tells them from a kept map's.
  expect(rows.every(row => row.hasAttribute("data-trace-live"))).toBe(true);
  expect(container.querySelector(".writing-offer-question")?.textContent).toContain("You answered: The spring one.");

  // Collapsed, the card leads with the first assumption: the same rule holds there.
  render({ ...props, map: { ...map, open: false }, offer });
  expect([...container.querySelectorAll(".writing-offer-assumption button")].map(item => item.textContent)).toEqual(["Correct it"]);
});
