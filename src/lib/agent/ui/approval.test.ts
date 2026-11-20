import { describe, expect, it } from "vitest";
import { approvalSpec } from "./approval";
import { renderableSpec } from "./content";

interface Element {
  type: string;
  props: Record<string, unknown>;
  children: string[];
}
const elementsOf = (spec: unknown) => (spec as { elements: Record<string, Element> }).elements;
const request = (args: Record<string, unknown>, preview: unknown = null) => ({
  question: "Allow Forge to run create_issue?",
  call: { server: "Forge", tool: "create_issue", arguments: args },
  preview,
});

describe("approvalSpec", () => {
  it("lays out exactly what is sent, short values as facts and long ones as text", () => {
    const description = "The ferry needs booking before Friday.\nAsk about the car.";
    const spec = approvalSpec(
      request({
        project: "OPS",
        summary: "Book the ferry",
        description,
        labels: ["travel", "urgent"],
        fields: { priority: { name: "High" }, points: 3, flagged: false, parent: null, note: "" },
        watchers: [{ name: "Ana" }, { name: "Ben" }],
        links: [],
        extra: {},
      }),
    )!;
    expect(renderableSpec(spec)).not.toBeNull();
    const elements = elementsOf(spec);
    expect(spec.root).toBe("call");
    expect(elements.call).toMatchObject({ type: "Card", props: { title: "What is sent" } });
    const shown = elements.call.children.map((id) => elements[id]);
    expect(shown.map((element) => element.type)).toEqual(["KeyValue", "Heading", "Text", "KeyValue"]);
    expect(shown[0].props.items).toEqual([
      { label: "project", value: "OPS" },
      { label: "summary", value: "Book the ferry" },
    ]);
    expect(shown[1].props.text).toBe("description");
    expect(shown[2].props.text).toBe(description);
    expect(shown[3].props.items).toEqual([
      { label: "labels", value: "travel, urgent" },
      { label: "fields.priority.name", value: "High" },
      { label: "fields.points", value: "3" },
      { label: "fields.flagged", value: "false" },
      { label: "fields.parent", value: "null" },
      { label: "fields.note", value: '""' },
      { label: "watchers[0].name", value: "Ana" },
      { label: "watchers[1].name", value: "Ben" },
      { label: "links", value: "[]" },
      { label: "extra", value: "{}" },
    ]);
  });

  it("says when a call sends nothing, and when it sends more than is shown", () => {
    const empty = elementsOf(approvalSpec(request({})));
    expect(empty[empty.call.children[0]].props.text).toBe("Nothing is sent with this call.");

    const many = Object.fromEntries(Array.from({ length: 85 }, (_, index) => [`field${index}`, index]));
    const wide = elementsOf(approvalSpec(request({ ...many, body: "x".repeat(6100) })));
    const shown = wide.call.children.map((id) => wide[id]);
    expect((shown[0].props.items as unknown[]).length).toBe(80);
    expect(shown[shown.length - 1].props.text).toBe("6 more values are sent and not shown here.");

    const long = elementsOf(approvalSpec(request({ body: "x".repeat(6100) })));
    expect(long[long.call.children[1]].props.text).toMatch(/…\n\[100 more characters are sent and not shown here\.\]$/);
  });

  it("shows the agent's preview above the exact call", () => {
    const preview = {
      root: "ticket",
      elements: {
        ticket: { type: "Card", props: { title: "OPS · Book the ferry" }, children: ["call"] },
        call: { type: "KeyValue", props: { items: [{ label: "Priority", value: "High" }] }, children: [] },
      },
    };
    const spec = approvalSpec(request({ summary: "Book the ferry" }, preview))!;
    expect(renderableSpec(spec)).not.toBeNull();
    const elements = elementsOf(spec);
    expect(elements[spec.root]).toMatchObject({ type: "Stack", children: ["preview/ticket", "call"] });
    expect(elements["preview/ticket"]).toMatchObject({ type: "Card", children: ["preview/call"] });
    expect(elements["preview/call"].type).toBe("KeyValue");
    expect(elements.call.props.title).toBe("What is sent");
    expect(elements[elements.call.children[0]].props.items).toEqual([{ label: "summary", value: "Book the ferry" }]);
  });

  it("drops a preview that isn't display blocks only, keeping the exact call", () => {
    const withInput = {
      root: "field",
      elements: { field: { type: "TextField", props: { label: "Summary", placeholder: null, multiline: null, value: null }, children: [] } },
    };
    const withPills = {
      root: "next",
      elements: { next: { type: "Suggestions", props: { items: ["Allow once"] }, children: [] } },
    };
    for (const preview of [withInput, withPills, { root: "missing", elements: {} }, "a ticket", 7]) {
      const spec = approvalSpec(request({ summary: "Book the ferry" }, preview))!;
      expect(spec.root).toBe("call");
      expect(Object.keys(elementsOf(spec)).every((id) => id.startsWith("call"))).toBe(true);
    }
  });

  it("shows nothing for a request that names no call", () => {
    expect(approvalSpec({ question: "Which day?" })).toBeNull();
    expect(approvalSpec({ call: { server: "Forge", tool: "create_issue", arguments: "x" } })).toBeNull();
    expect(approvalSpec(null)).toBeNull();
  });
});
