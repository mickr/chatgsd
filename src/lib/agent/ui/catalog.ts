import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

const tone = z.enum(["info", "warning", "success"]);

/**
 * The UI vocabulary the agent may use: display blocks for replies and inputs for
 * ask_user forms. The registry in components/agent/ui renders each type, and
 * the guide below is generated from these definitions so the two can't drift.
 */
export const componentDefinitions = {
  Stack: {
    props: z.object({
      direction: z.enum(["vertical", "horizontal"]).nullable(),
      gap: z.enum(["sm", "md", "lg"]).nullable(),
    }),
    slots: ["default"],
    description: "Groups child blocks in a column (default) or a row.",
  },
  Card: {
    props: z.object({ title: z.string().nullable() }),
    slots: ["default"],
    description: "A bordered group with an optional title.",
  },
  Heading: {
    props: z.object({ text: z.string() }),
    description: "A short section heading.",
  },
  Text: {
    props: z.object({
      text: z.string(),
      tone: z.enum(["default", "muted"]).nullable(),
    }),
    description: "A paragraph of plain text.",
  },
  List: {
    props: z.object({
      items: z.array(z.string()),
      ordered: z.boolean().nullable(),
    }),
    description: "A bulleted or numbered list of short items.",
  },
  Table: {
    props: z.object({
      columns: z.array(z.string()),
      rows: z.array(z.array(z.string())),
    }),
    description: "Compare a few items side by side. Keep it to 2 to 4 columns.",
  },
  KeyValue: {
    props: z.object({
      items: z.array(z.object({ label: z.string(), value: z.string() })),
    }),
    description: "Labelled facts about one thing (dates, owners, totals).",
  },
  Checklist: {
    props: z.object({
      items: z.array(z.object({ label: z.string(), done: z.boolean() })),
    }),
    description: "Read-only status of tasks or steps.",
  },
  Callout: {
    props: z.object({
      tone,
      title: z.string().nullable(),
      text: z.string(),
    }),
    description: "Highlight a conflict, risk or confirmation.",
  },
  NoteLink: {
    props: z.object({
      id: z.string(),
      title: z.string(),
      detail: z.string().nullable(),
    }),
    description:
      "A link to another note by ID (from list_notes, search_notes or read_notes). Clicking opens it.",
  },
  Choice: {
    props: z.object({
      label: z.string(),
      options: z.array(
        z.object({
          value: z.string(),
          label: z.string(),
          description: z.string().nullable(),
        }),
      ),
      multiple: z.boolean().nullable(),
      value: z.union([z.string(), z.array(z.string())]).nullable(),
    }),
    description:
      'ask_user forms only. Pick one option, or several when multiple is true. Bind value: {"$bindState":"/answers/<key>"}.',
  },
  TextField: {
    props: z.object({
      label: z.string(),
      placeholder: z.string().nullable(),
      multiline: z.boolean().nullable(),
      value: z.string().nullable(),
    }),
    description:
      'ask_user forms only. Short free-text answer. Bind value: {"$bindState":"/answers/<key>"}.',
  },
  Toggle: {
    props: z.object({ label: z.string(), value: z.boolean().nullable() }),
    description:
      'ask_user forms only. A yes/no switch. Bind value: {"$bindState":"/answers/<key>"}.',
  },
};

export type ComponentType = keyof typeof componentDefinitions;

export const catalog = defineCatalog(schema, {
  components: componentDefinitions,
  actions: {},
});

/** Compact TypeScript-like rendering of a JSON Schema for the guide. */
function describeSchema(node: unknown): string {
  if (!node || typeof node !== "object") return "unknown";
  const schemaNode = node as {
    type?: string | string[];
    enum?: unknown[];
    anyOf?: unknown[];
    items?: unknown;
    properties?: Record<string, unknown>;
  };
  if (schemaNode.enum)
    return schemaNode.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schemaNode.anyOf)
    return schemaNode.anyOf.map(describeSchema).join(" | ");
  if (schemaNode.type === "array")
    return `${describeSchema(schemaNode.items)}[]`;
  if (schemaNode.type === "object" && schemaNode.properties)
    return `{ ${Object.entries(schemaNode.properties)
      .map(([key, value]) => `${key}: ${describeSchema(value)}`)
      .join(", ")} }`;
  return Array.isArray(schemaNode.type)
    ? schemaNode.type.join(" | ")
    : (schemaNode.type ?? "unknown");
}

const componentLines = Object.entries(componentDefinitions).map(
  ([name, definition]) => {
    const props = describeSchema(z.toJSONSchema(definition.props));
    const children = "slots" in definition ? " [children]" : "";
    return `- ${name}${children} props ${props}. ${definition.description}`;
  },
);

/** Appended to the agent's instructions; describes spec blocks and ask_user forms. */
export const uiGuide = `Scratch UI blocks: when structure makes an answer clearer (comparing options, several facts about one thing, steps, related notes), add a spec block after your prose. Otherwise answer in plain text. Never invent data: show only what is in the notes, the user's messages or tool results.
A spec block is a fenced block tagged spec with one JSON Patch operation per line that builds a flat tree:
\`\`\`spec
{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Options"},"children":["table"]}}
{"op":"add","path":"/elements/table","value":{"type":"Table","props":{"columns":["Option","Cost"],"rows":[["Train","$40"],["Drive","$25"]]},"children":[]}}
\`\`\`
Every element needs type, props (all listed props, null when unused) and children (element IDs, [] for none).
For ask_user, pass form as a complete spec object {root, elements, state} instead of patch lines. Bind each input's value to {"$bindState":"/answers/<key>"} and seed state.answers with an initial value per key. Scratch adds the send button and returns the answers object. Use a form when the question has several parts or needs context alongside it; for one simple choice, options alone are enough.
Components:
${componentLines.join("\n")}`;
