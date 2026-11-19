/**
 * The ledger an outcome trace works back through: what the writer asked, and
 * what the agent's tools brought back, from this note's conversation. A trace
 * step may cite an entry by id, but only with text copied from that entry.
 */
export type ProvenanceKind = "you" | "web" | "service" | "note" | "edit" | "trace";
export interface ProvenanceEntry {
  id: string;
  kind: ProvenanceKind;
  /** What it was: the question researched, the service and tool called, the notes read. */
  label: string;
  /** What came back, or for an edit, the text the agent wrote. */
  text: string;
  /** Pages research opened, for a web entry. */
  urls?: string[];
  /** This edit wrote some of the highlighted text. */
  wroteHighlight?: boolean;
  /** The conversation item it came from, to show it there. */
  itemId?: string;
}
interface LedgerItem {
  id?: string; type: string; text?: string; name?: string; input?: unknown; ok?: boolean; output?: string;
  /** An earlier argument map's offer and corrections, for a trace item. */
  offer?: { quote: string; explanation: string }; corrections?: { step: number; meant: string }[];
}

const MAX_ENTRIES = 24;
const MAX_ENTRY = 1500;
const MAX_LEDGER = 14000;
const NOTE_TOOLS = new Set(["read_notes", "search_notes", "find_in_note", "list_notes", "note_links", "search_projects", "list_projects"]);
const EDIT_TOOLS = new Set(["edit_document", "replace_selection", "edit_note"]);

function field(input: unknown, key: string): unknown {
  return input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}
const words = (value: unknown, max = 200) => (typeof value === "string" ? value : JSON.stringify(value ?? "")).replace(/\s+/g, " ").trim().slice(0, max);

function editedText(name: string, input: unknown): string {
  if (name === "replace_selection") return String(field(input, "new_text") ?? "");
  const edits = field(input, "edits");
  return Array.isArray(edits) ? edits.map(edit => String(field(edit, "new_text") ?? "")).filter(Boolean).join("\n\n") : "";
}

/** Some sentence of the highlight appears in this edit's text: it put that text there. */
function wrote(text: string, highlight: string): boolean {
  const normal = (value: string) => value.replace(/\s+/g, " ").trim();
  const written = normal(text);
  return normal(highlight).split(/(?<=[.!?])\s+/).some(sentence => sentence.length >= 12 && written.includes(sentence));
}

const URL_PATTERN = /https?:\/\/[^\s<>()"']+/g;

/** The ledger, oldest first, keeping the most recent entries that fit. */
export function provenanceLedger(items: readonly LedgerItem[], highlight = ""): ProvenanceEntry[] {
  const entries: Omit<ProvenanceEntry, "id">[] = [];
  for (const item of items) {
    const before = entries.length;
    addEntry(item, entries, highlight);
    if (item.id) for (let index = before; index < entries.length; index++) entries[index].itemId = item.id;
  }
  return keep(entries);
}

function addEntry(item: LedgerItem, entries: Omit<ProvenanceEntry, "id">[], highlight: string): void {
  if (item.type === "user" && item.text?.trim()) {
    entries.push({ kind: "you", label: "You said", text: item.text.trim() });
    return;
  }
  if (item.type === "trace" && item.offer) {
    // An earlier map is evidence too: what it learned, and what the writer said it got wrong.
    const corrected = (item.corrections ?? []).map(correction => `The writer corrected step ${correction.step + 1}: ${correction.meant}`);
    entries.push({ kind: "trace", label: `Earlier map of "${words(item.offer.quote, 120)}"`,
      text: [`What we learned: ${item.offer.explanation}`, ...corrected].join("\n") });
    return;
  }
  if (item.type !== "tool" || !item.ok || !item.name) return;
  const output = item.output?.trim() ?? "";
  if (item.name === "research" && output)
    entries.push({ kind: "web", label: `Research: ${words(field(item.input, "question"))}`, text: output,
      urls: [...new Set(output.match(URL_PATTERN) ?? [])].slice(0, 8) });
  else if (item.name === "mcp_call" && output)
    entries.push({ kind: "service", label: `${words(field(item.input, "server"), 80)} · ${words(field(item.input, "tool"), 80)}`, text: output });
  else if (NOTE_TOOLS.has(item.name) && output)
    entries.push({ kind: "note", label: `${item.name.replace(/_/g, " ")}: ${words(item.input, 120)}`, text: output });
  else if (EDIT_TOOLS.has(item.name)) {
    const text = editedText(item.name, item.input);
    if (text) entries.push({ kind: "edit", label: item.name === "edit_note" ? `Edited ${words(field(item.input, "id"), 80)}` : "Edited this note",
      text, ...(highlight && wrote(text, highlight) ? { wroteHighlight: true } : {}) });
  }
}

/** The most recent entries that fit, numbered by their place in the whole conversation. */
function keep(entries: Omit<ProvenanceEntry, "id">[]): ProvenanceEntry[] {
  const kept: ProvenanceEntry[] = [];
  let size = 0;
  for (let index = entries.length - 1; index >= 0 && kept.length < MAX_ENTRIES; index--) {
    const entry = entries[index];
    const text = entry.text.length > MAX_ENTRY ? `${entry.text.slice(0, MAX_ENTRY)}…` : entry.text;
    size += text.length + entry.label.length;
    if (size > MAX_LEDGER && kept.length) break;
    kept.unshift({ ...entry, id: `e${index + 1}`, text });
  }
  return kept;
}

const normal = (value: string) => value.replace(/\s+/g, " ").trim();

/** The entry a trace step cites, if its quote really is from that entry. */
export function citedEntry(ledger: readonly ProvenanceEntry[], id: string, quote: string): ProvenanceEntry {
  const entry = ledger.find(item => item.id === id);
  if (!entry) throw new Error(`No context entry ${id}. Cite an id from the supplied ledger, or null for the open note.`);
  if (!normal(entry.text).includes(normal(quote)) && !normal(entry.label).includes(normal(quote)))
    throw new Error(`That quote isn't in context entry ${id}. Copy its exact text.`);
  return entry;
}
