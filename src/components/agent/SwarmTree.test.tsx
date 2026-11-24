// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SwarmItem } from "../../context/AgentContext";
import { SwarmTree } from "./SwarmTree";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let container: HTMLDivElement;

const baseSwarm = (workers: SwarmItem["workers"]): SwarmItem => ({
  id: "run-1:swarm-a",
  type: "swarm",
  runId: "run-1",
  swarmId: "swarm-a",
  goal: "Review draft from three angles",
  workers,
});

const buttonByText = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

it("renders connector lines from the coordinator down to each agent and supports drain/stop controls", () => {
  const onStopWorker = vi.fn();
  const onStopAll = vi.fn();
  const onDrain = vi.fn();
  const onCleanup = vi.fn();

  const swarm = baseSwarm([
    {
      workerId: "w1",
      name: "Clarity",
      role: "Style check",
      model: "gpt-5.4",
      status: "running",
      activity: "Reading open note",
      steps: 2,
      updatedAt: 1000,
    },
    {
      workerId: "w2",
      name: "Fact Check",
      role: "Claims",
      model: "agy:gemini-3-flash",
      status: "checking",
      activity: "Researching claim",
      steps: 3,
      checkedAt: 1000,
      updatedAt: 1000,
    },
    {
      workerId: "w3",
      name: "Counterarguments",
      role: "Critique",
      status: "completed",
      activity: "Completed · PASS",
      outcome: "PASS",
      output: "PASS\nAll claims are well supported.",
      steps: 1,
      updatedAt: 1000,
    },
  ]);

  act(() => {
    root.render(
      <SwarmTree
        swarm={swarm}
        activeRun={true}
        onStopWorker={onStopWorker}
        onStopAll={onStopAll}
        onDrain={onDrain}
        onCleanup={onCleanup}
      />,
    );
  });

  // Coordinator reflects active checking state and goal
  expect(container.textContent).toContain("Coordinator");
  expect(container.textContent).toContain("Checking on 1 of 3 agents");
  expect(container.textContent).toContain("Review draft from three angles");
  expect(container.textContent).toContain("gemini-3-flash");
  expect(container.textContent).toContain("PASS");

  // SVG branch connectors go down to every worker
  const connectors = container.querySelectorAll(".agent-swarm-connector-svg");
  expect(connectors.length).toBe(3);

  // Stop an individual running worker
  const stopClarity = container.querySelector<HTMLButtonElement>('button[aria-label="Stop Clarity"]');
  expect(stopClarity).toBeTruthy();
  act(() => stopClarity!.click());
  expect(onStopWorker).toHaveBeenCalledWith("run-1", "w1");

  // Drain and Stop all controls work
  act(() => buttonByText("Drain")!.click());
  expect(onDrain).toHaveBeenCalledWith("run-1");

  act(() => buttonByText("Stop all")!.click());
  expect(onStopAll).toHaveBeenCalledWith("run-1");
});

it("offers Clean up when all agents settle and collapses once cleaned up", () => {
  const onCleanup = vi.fn();
  const settled = baseSwarm([
    {
      workerId: "w1",
      name: "Clarity",
      role: "Style check",
      status: "completed",
      outcome: "ISSUES",
      output: "ISSUES\nParagraph 2 repeats the intro.",
      steps: 2,
      updatedAt: 2000,
    },
    {
      workerId: "w2",
      name: "Facts",
      role: "Claims",
      status: "stopped",
      activity: "Stopped by user",
      steps: 1,
      updatedAt: 2000,
    },
  ]);

  act(() => {
    root.render(
      <SwarmTree
        swarm={settled}
        activeRun={false}
        onStopWorker={vi.fn()}
        onStopAll={vi.fn()}
        onDrain={vi.fn()}
        onCleanup={onCleanup}
      />,
    );
  });

  expect(buttonByText("Drain")).toBeUndefined();
  expect(buttonByText("Stop all")).toBeUndefined();
  const cleanBtn = buttonByText("Clean up");
  expect(cleanBtn).toBeTruthy();
  act(() => cleanBtn!.click());
  expect(onCleanup).toHaveBeenCalledWith("run-1", "swarm-a");

  // Re-render in cleaned_up state: collapsed by default, expandable via Inspect
  const cleaned = baseSwarm(
    settled.workers.map((w) => ({ ...w, status: "cleaned_up", activity: "Cleaned up" })),
  );
  act(() => {
    root.render(
      <SwarmTree
        swarm={cleaned}
        activeRun={false}
        onStopWorker={vi.fn()}
        onStopAll={vi.fn()}
        onDrain={vi.fn()}
        onCleanup={onCleanup}
      />,
    );
  });

  expect(container.textContent).toContain("Cleaned up · 2 agents");
  expect(container.querySelectorAll(".agent-swarm-branch-row").length).toBe(0);

  act(() => buttonByText("Inspect")!.click());
  expect(container.querySelectorAll(".agent-swarm-branch-row").length).toBe(2);
});
