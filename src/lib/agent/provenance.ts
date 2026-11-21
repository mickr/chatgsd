/**
 * The ledger an argument trace works back through: what the writer said or
 * answered, what we discussed, and what the agent's tools brought back or edited
 * in this note's conversation. A trace step may cite an entry by id, quoting its text.
 */
export type ProvenanceKind = "you" | "chat" | "web" | "service" | "note" | "edit" | "trace";
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
  id?: string; type: string; text?: string; selection?: string; name?: string; input?: unknown; ok?: boolean; output?: string;
  question?: string; answer?: string | null; preview?: unknown;
  /** An earlier argument map's offer, corrections, confirmations, and answer, for a trace item. */
  offer?: { quote: string; explanation: string };
  corrections?: { step: number; meant: string }[];
  confirmed?: { step: number; reading: string }[];
}
interface RawEntry { entry: Omit<ProvenanceEntry, "id">; turn: number; index: number }

const MAX_ENTRIES = 24;
const MAX_ENTRY = 1500;
const MAX_LEDGER = 14000;
const MAX_PINNED_ENTRIES = 12;
const MAX_PINNED_LEDGER = 7000;
/** Separates what the writer said from the passage they had selected, in a "you" entry. */
const SELECTED_PASSAGE = "\nSelected passage: ";
const NOTE_TOOLS = new Set(["read_notes", "search_notes", "find_in_note", "list_notes", "note_links", "search_projects", "list_projects"]);
const EDIT_TOOLS = new Set(["edit_document", "replace_selection", "edit_note"]);

export function displayInstruction(text: string): string {
  // Older saved conversations used the edit-only preamble.
  if (!text.startsWith("Inline agent request.") &&
      !text.startsWith("Inline edit request. Apply the instruction directly in the current note.")) return text;
  const separator = "\n\nUser instruction:\n\n";
  const start = text.indexOf(separator);
  return start < 0 ? text : text.slice(start + separator.length);
}

function stripSpecBlocks(text: string): string {
  const lines: string[] = [];
  let inSpec = false;
  for (const line of text.split("\n")) {
    if (!inSpec && /^\s*```spec\s*$/.test(line)) { inSpec = true; continue; }
    if (inSpec) { if (/^\s*```\s*$/.test(line)) inSpec = false; continue; }
    lines.push(line);
  }
  return lines.join("\n").trim();
}

function field(input: unknown, key: string): unknown {
  return input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}
const words = (value: unknown, max = 200) => (typeof value === "string" ? value : JSON.stringify(value ?? "")).replace(/\s+/g, " ").trim().slice(0, max);
const normal = (value: string) => value.replace(/\s+/g, " ").trim();

function editedParts(name: string, input: unknown): { written: string; replaced: string } {
  if (name === "replace_selection") return { written: String(field(input, "new_text") ?? ""), replaced: "" };
  const edits = field(input, "edits");
  if (!Array.isArray(edits)) return { written: "", replaced: "" };
  return {
    written: edits.map(edit => String(field(edit, "new_text") ?? "")).filter(Boolean).join("\n\n"),
    replaced: edits.map(edit => String(field(edit, "old_text") ?? "")).filter(Boolean).join("\n\n"),
  };
}

function highlightSentences(highlight: string): string[] {
  return normal(highlight).split(/(?<=[.!?])\s+/).filter(sentence => sentence.length >= 12);
}

/** Some sentence of the highlight appears in this edit's text: it put that text there. */
function wrote(text: string, highlight: string): boolean {
  const written = normal(text);
  return highlightSentences(highlight).some(sentence => written.includes(sentence));
}

/** Keep both the opening and the conclusion/URLs at the end, plus any middle sentence that wrote the highlight. */
function clipEntryText(text: string, highlight: string): string {
  if (text.length <= MAX_ENTRY) return text;
  const headSize = 900;
  const tailSize = 595;
  const tailStart = text.length - tailSize;
  if (highlight) {
    for (const sentence of highlightSentences(highlight)) {
      const probe = sentence.slice(0, 60);
      const hit = text.indexOf(probe);
      if (hit >= headSize - probe.length && hit <= tailStart) {
        const midStart = Math.max(500, hit - 120);
        const midEnd = Math.min(text.length - 480, midStart + 500);
        if (midEnd > midStart)
          return `${text.slice(0, 500)}\n…\n${text.slice(midStart, midEnd)}\n…\n${text.slice(text.length - 480)}`;
      }
    }
  }
  return `${text.slice(0, headSize)}\n…\n${text.slice(tailStart)}`;
}

const URL_PATTERN = /https?:\/\/[^\s<>()"']+/g;

/** The ledger, oldest first, keeping causal and relevant turns alongside the most recent entries that fit. */
export function provenanceLedger(items: readonly LedgerItem[], highlight = "", requiredIds?: ReadonlySet<string>): ProvenanceEntry[] {
  const editedTurns = new Set<number>();
  let scanTurn = 0;
  for (const item of items) {
    if (!scanTurn || item.type === "user" || item.type === "activity") scanTurn++;
    if (item.type === "tool" && item.ok && item.name && EDIT_TOOLS.has(item.name)) editedTurns.add(scanTurn);
  }
  const raw: RawEntry[] = [];
  let turn = 0;
  for (const item of items) {
    if (!turn || item.type === "user" || item.type === "activity") turn++;
    const entries: Omit<ProvenanceEntry, "id">[] = [];
    addEntry(item, entries, highlight, editedTurns.has(turn));
    for (const entry of entries) {
      if (item.id) entry.itemId = item.id;
      raw.push({ entry: { ...entry, text: clipEntryText(entry.text, highlight) }, turn, index: raw.length });
    }
  }
  return keep(raw, highlight, requiredIds);
}

function addEntry(item: LedgerItem, entries: Omit<ProvenanceEntry, "id">[], highlight: string, turnEdited: boolean): void {
  if (item.type === "user" && item.text?.trim()) {
    const instruction = displayInstruction(item.text).trim();
    if (!instruction) return;
    const selection = item.selection?.trim();
    entries.push({ kind: "you", label: "You said",
      text: selection ? `${instruction}${SELECTED_PASSAGE}${selection}` : instruction });
    return;
  }
  if (item.type === "question") {
    const question = item.question?.trim();
    const answer = typeof item.answer === "string" ? item.answer.trim() : "";
    if (!item.preview && question && answer && answer !== "Continued after your document edit.")
      entries.push({ kind: "you", label: `Answered: ${words(question, 120)}`, text: `Question: ${question}\nAnswer: ${answer}` });
    return;
  }
  if (item.type === "text" && item.text?.trim()) {
    const prose = stripSpecBlocks(item.text);
    // Routine post-edit acknowledgements duplicate the edit entry; keep substantive replies and discussion turns.
    if (prose.length >= (turnEdited ? 240 : 12))
      entries.push({ kind: "chat", label: "Earlier reply", text: prose });
    return;
  }
  if (item.type === "trace" && item.offer) {
    // An earlier map is evidence too: what it learned, what the writer confirmed, and what they said it got wrong.
    const corrected = (item.corrections ?? []).map(correction => `The writer corrected step ${correction.step + 1}: ${correction.meant}`);
    const confirmed = (item.confirmed ?? []).map(confirmation => `The writer confirmed step ${confirmation.step + 1}: ${confirmation.reading}`);
    const answered = typeof item.answer === "string" && item.answer.trim() ? [`The writer answered: ${item.answer.trim()}`] : [];
    entries.push({ kind: "trace", label: `Earlier map of "${words(item.offer.quote, 120)}"`,
      text: [`What we learned: ${item.offer.explanation}`, ...corrected, ...confirmed, ...answered].join("\n") });
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
    const { written, replaced } = editedParts(item.name, item.input);
    if (written) {
      const text = replaced.trim() && replaced.trim() !== written.trim()
        ? `${written}\nReplaced: ${replaced.trim().slice(0, 500)}`
        : written;
      entries.push({ kind: "edit", label: item.name === "edit_note" ? `Edited ${words(field(item.input, "id"), 80)}` : "Edited this note",
        text, ...(highlight && wrote(written, highlight) ? { wroteHighlight: true } : {}) });
    }
  }
}

function termsOf(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{5,}/gu) ?? []).slice(0, 64));
}

/** The entries that fit, pinning causal turns for the highlight before filling with the most recent context. */
function keep(raw: RawEntry[], highlight: string, requiredIds?: ReadonlySet<string>): ProvenanceEntry[] {
  const entrySize = (item: RawEntry) => item.entry.text.length + item.entry.label.length;
  const chosen = new Set<number>();
  let size = 0;

  if (requiredIds?.size) {
    for (const item of raw) {
      if (!requiredIds.has(`e${item.index + 1}`)) continue;
      const cost = entrySize(item);
      if (chosen.size >= MAX_ENTRIES || (size + cost > MAX_LEDGER && chosen.size > 0)) break;
      chosen.add(item.index);
      size += cost;
    }
  }

  if (raw.length > MAX_ENTRIES || raw.reduce((sum, item) => sum + entrySize(item), 0) > MAX_LEDGER) {
    const highlightTerms = highlight ? termsOf(highlight) : new Set<string>();
    const minOverlap = highlightTerms.size >= 2 ? 2 : highlightTerms.size;
    const byTurn = new Map<number, RawEntry[]>();
    for (const item of raw) {
      const group = byTurn.get(item.turn) ?? [];
      group.push(item);
      byTurn.set(item.turn, group);
    }
    const candidates: Array<{ score: number; turn: number; items: RawEntry[] }> = [];
    for (const [turn, group] of byTurn) {
      let score = 0;
      if (group.some(item => item.entry.wroteHighlight)) score = 100;
      else if (group.some(item => item.entry.kind === "trace" &&
          (item.entry.text.includes("The writer corrected step") ||
           item.entry.text.includes("The writer confirmed step") ||
           item.entry.text.includes("The writer answered:")))) score = 80;
      else if (minOverlap > 0) {
        const turnText = group.map(item => `${item.entry.label} ${item.entry.text}`).join(" ").toLowerCase();
        let hits = 0;
        for (const term of highlightTerms) if (turnText.includes(term)) hits++;
        if (hits >= minOverlap) score = 10 + hits;
      }
      if (score > 0) candidates.push({ score, turn, items: group });
    }
    candidates.sort((a, b) => b.score - a.score || b.turn - a.turn);
    for (const candidate of candidates) {
      const unseen = candidate.items.filter(item => !chosen.has(item.index));
      const cost = unseen.reduce((sum, item) => sum + entrySize(item), 0);
      if (!unseen.length || chosen.size + unseen.length > MAX_PINNED_ENTRIES || size + cost > MAX_PINNED_LEDGER) continue;
      for (const item of unseen) chosen.add(item.index);
      size += cost;
    }
  }

  for (let index = raw.length - 1; index >= 0 && chosen.size < MAX_ENTRIES; index--) {
    if (chosen.has(index)) continue;
    const cost = entrySize(raw[index]);
    if (size + cost > MAX_LEDGER && chosen.size > 0) break;
    chosen.add(index);
    size += cost;
  }

  return [...chosen].sort((a, b) => a - b).map(index => ({ ...raw[index].entry, id: `e${index + 1}` }));
}

/** The entry a trace step cites, if its quote really is from that entry. */
export function citedEntry(ledger: readonly ProvenanceEntry[], id: string, quote: string): ProvenanceEntry {
  const entry = ledger.find(item => item.id === id);
  if (!entry) throw new Error(`No context entry ${id}. Cite an id from the supplied ledger, or null for the open note.`);
  if (!normal(entry.text).includes(normal(quote)) && !normal(entry.label).includes(normal(quote)))
    throw new Error(`That quote isn't in context entry ${id}. Copy its exact text.`);
  return entry;
}

export interface PriorMemoryChoice {
  key: string;
  kind: string;
  summary: string;
  quote: string | null;
  next?: string | null;
}

const CLARIFY_STOPWORDS = new Set([
  "this", "that", "these", "those", "with", "from", "have", "were", "been", "being", "what", "when", "where",
  "which", "while", "there", "their", "they", "them", "then", "than", "would", "could", "should", "about", "into",
  "over", "under", "after", "before", "only", "also", "just", "more", "most", "some", "such", "very", "same",
  "other", "each", "both", "either", "neither", "rather", "instead", "because", "since", "though", "still",
  "here", "does", "did", "done", "make", "made", "mean", "means", "meant", "assumed", "assume", "assuming",
  "took", "take", "taken", "read", "reading", "step", "note", "passage", "selected", "question", "answer",
  "answered", "earlier", "learned", "writer", "confirmed", "corrected", "your", "ours", "will",
  // Three-letter function words pass the length floor and would count as shared content in any two sentences.
  "the", "and", "for", "are", "was", "not", "but", "you", "all", "any", "can", "had", "has", "her", "him", "his",
  "how", "its", "our", "out", "who", "why", "may", "nor", "too", "yet", "off", "own", "now", "per", "via",
]);

function stemToken(token: string): string {
  if (token.length >= 6 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length >= 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length >= 5 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length >= 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function contentTerms(text: string): Set<string> {
  const terms = new Set<string>();
  // Letters and digits of any script: a note in Russian or French has words to share too.
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    if (CLARIFY_STOPWORDS.has(raw)) continue;
    const stem = stemToken(raw);
    if (!CLARIFY_STOPWORDS.has(stem) && stem.length >= 3) terms.add(stem);
  }
  return terms;
}

function sameAnchoredPassage(a: string, b: string): boolean {
  const left = normal(a).toLowerCase();
  const right = normal(b).toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = Math.min(left.length, right.length);
  return shorter >= 8 && (left.includes(right) || right.includes(left));
}

function overlapCount(needles: ReadonlySet<string>, haystack: ReadonlySet<string>): number {
  let count = 0;
  for (const item of needles) if (haystack.has(item)) count++;
  return count;
}

/** One shared word is coincidence: two must match when the reading offers that many. */
function speaksTo(target: ReadonlySet<string>, tokens: ReadonlySet<string>): boolean {
  return target.size > 0 && overlapCount(target, tokens) >= Math.min(2, target.size);
}

/** A "you" entry without the passage that was selected with it: only what the writer wrote. */
function writersWords(entry: ProvenanceEntry): string {
  return `${entry.label}\n${entry.text.split(SELECTED_PASSAGE)[0]}`;
}

/**
 * Looks for an earlier answer to an unsure trace step (`sure: false`): a saved
 * writer `meaning-*` choice or an earlier writer turn in the conversation ledger.
 * It matches on shared words, so a match is a lead to show the writer, never proof.
 */
export function findPriorStepAnswer(
  step: { quote: string; reading: string; sure: boolean; source?: string | null },
  ledger: readonly ProvenanceEntry[] = [],
  memory: readonly PriorMemoryChoice[] = [],
): ProvenanceEntry | null {
  if (step.sure || step.source) return null;

  const quoteTerms = contentTerms(step.quote);
  const readingTerms = contentTerms(step.reading);
  const readingSpecific = new Set([...readingTerms].filter(term => !quoteTerms.has(term)));
  const quoteNorm = normal(step.quote).toLowerCase();

  for (let idx = memory.length - 1; idx >= 0; idx--) {
    const item = memory[idx];
    if (item.kind !== "choice" || !item.key.startsWith("meaning-") || !item.quote) continue;
    // The same passage can hold several assumptions: the saved meaning has to be about this one.
    if (sameAnchoredPassage(item.quote, step.quote) && overlapCount(readingTerms, contentTerms(item.summary)) >= 1) {
      return {
        id: item.key,
        kind: "you",
        label: item.next ? "Earlier clarification" : "Confirmed assumption",
        text: item.summary,
      };
    }
  }

  const targetTerms = readingSpecific.size > 0 ? readingSpecific : readingTerms;
  for (let idx = ledger.length - 1; idx >= 0; idx--) {
    const entry = ledger[idx];
    if (entry.kind === "trace") {
      const writerLines = entry.text
        .split("\n")
        .filter(line => /^The writer (?:confirmed|corrected|answered)/.test(line))
        .join("\n");
      if (!writerLines) continue;
      const traceTokens = contentTerms(`${entry.label} ${writerLines}`);
      const writerTokens = contentTerms(writerLines);
      const hasAnchor = (quoteNorm.length >= 8 && normal(entry.label).toLowerCase().includes(quoteNorm)) ||
        (quoteTerms.size > 0 && overlapCount(quoteTerms, traceTokens) >= 1);
      if (hasAnchor && speaksTo(targetTerms, writerTokens)) return entry;
      continue;
    }

    if (entry.kind !== "you") continue;
    const fullText = `${entry.label}\n${entry.text}`;
    const entryNorm = normal(fullText).toLowerCase();
    const entryTokens = contentTerms(fullText);
    // Selecting a passage says nothing about it: the answer has to be in the writer's own words.
    if (!speaksTo(targetTerms, contentTerms(writersWords(entry)))) continue;

    if (quoteNorm.length >= 8 && entryNorm.includes(quoteNorm)) return entry;

    if (!quoteTerms.size || overlapCount(quoteTerms, entryTokens) < 1) continue;
    if (overlapCount(new Set([...quoteTerms, ...readingTerms]), entryTokens) >= 2) return entry;
  }

  return null;
}
