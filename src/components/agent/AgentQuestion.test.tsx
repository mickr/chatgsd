// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QuestionItem } from "../../context/AgentContext";
import { approvalSpec } from "../../lib/agent/ui/approval";
import { AgentQuestion } from "./AgentQuestion";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
const onAnswer = vi.fn();

const approval: QuestionItem = {
  id: "q1",
  type: "question",
  runId: "run-1",
  requestId: "q1",
  question: "Allow Forge to run create_issue?",
  options: ["Create ticket", "Always allow", "Don't allow"],
  form: null,
  preview: approvalSpec({
    call: { server: "Forge", tool: "create_issue", arguments: { project: "OPS", summary: "Book the ferry" } },
    preview: {
      root: "ticket",
      elements: { ticket: { type: "Card", props: { title: "OPS · Book the ferry" }, children: [] } },
    },
  }),
  answer: null,
};
const render = (item: QuestionItem, pending: boolean) =>
  act(() => root.render(<AgentQuestion item={item} pending={pending} onAnswer={onAnswer} />));
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);

beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  onAnswer.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("shows a waiting call as the agent laid it out, with what is sent, above the buttons", () => {
  render(approval, true);
  expect(container.querySelector("details")).toBeNull();
  const text = container.textContent!;
  expect(text).toContain("OPS · Book the ferry");
  expect(text).toContain("What is sent");
  expect(text.indexOf("OPS · Book the ferry")).toBeLessThan(text.indexOf("What is sent"));
  expect(text.indexOf("What is sent")).toBeLessThan(text.indexOf("Create ticket"));
  expect(container.querySelectorAll("dt")[1].textContent).toBe("summary");
  expect(container.querySelectorAll("dd")[1].textContent).toBe("Book the ferry");

  act(() => button("Create ticket")!.click());
  expect(onAnswer).toHaveBeenCalledWith("Create ticket");
});

it("keeps an answered call a click away", () => {
  render({ ...approval, answer: "Create ticket" }, false);
  expect(container.textContent).toContain("You answered: Create ticket");
  expect(button("Create ticket")).toBeUndefined();
  const call = container.querySelector("details")!;
  expect(call.open).toBe(false);
  expect(call.querySelector("summary")!.textContent).toBe("Show the call");
  expect(call.textContent).toContain("What is sent");
});

it("leaves a plain question as it was", () => {
  render({ ...approval, question: "Which day?", options: ["Saturday", "Sunday"], preview: null }, true);
  expect(container.querySelector("details")).toBeNull();
  expect(container.textContent).not.toContain("What is sent");
  expect(button("Sunday")).toBeDefined();
});
