// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "../services/agent";
import {
  AgentProvider,
  useAgent,
  type AgentContextValue,
} from "./AgentContext";

vi.mock("../services/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof agent>()),
  getStatus: vi.fn(),
  listModels: vi.fn(),
  onAgentEvent: vi.fn(() => Promise.resolve(() => {})),
  onToolRequest: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../services/notes", () => ({
  getSettings: vi.fn(() => Promise.resolve({})),
  updateSettings: vi.fn(() => Promise.resolve()),
}));
vi.mock("./NotesContext", () => ({
  useNotes: () => ({ currentNote: null, notesFolder: "/notes" }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const READY: agent.AgentStatus = {
  status: "ready",
  detail: null,
  account: { email: "me@example.com", planUsage: true, planNoticeSeen: true },
};

let root: Root;
let current: AgentContextValue;

function Probe() {
  current = useAgent();
  return null;
}

/** Let the mocked request promises and the effects they trigger settle. */
async function settle() {
  await act(async () => {
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
  });
}

beforeEach(async () => {
  vi.mocked(agent.getStatus).mockResolvedValue(READY);
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      <AgentProvider editorRef={{ current: null }} editor={null}>
        <Probe />
      </AgentProvider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  vi.clearAllMocks();
});

describe("AgentProvider model list", () => {
  it("retries a failed model request while the account stays ready", async () => {
    vi.mocked(agent.listModels)
      .mockRejectedValueOnce(new Error("Network down"))
      .mockResolvedValueOnce([{ id: "gpt-x", label: "GPT X" }]);

    act(() => current.toggle());
    await settle();
    expect(current.status?.status).toBe("ready");
    expect(current.modelsError).toBe("Network down");
    expect(current.models).toEqual([]);

    // A status refresh alone returns "ready" again and must not be relied on.
    act(() => current.reloadModels());
    await settle();

    expect(agent.listModels).toHaveBeenCalledTimes(2);
    expect(current.status?.status).toBe("ready");
    expect(current.modelsError).toBeNull();
    expect(current.models).toEqual([{ id: "gpt-x", label: "GPT X" }]);
    expect(current.model).toBe("gpt-x");
  });
});
