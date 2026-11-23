import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * What a passage means to the rest of its note, for an edit that has to keep
 * the big picture: where the note is going, where the passage sits, and the
 * words other parts of the note rely on it for. Built from the open document,
 * so it costs no model step.
 */
export interface NoteMap {
  title: string;
  /** The note's first paragraph, which usually states what it's for. */
  opening: string;
  /** The headings, indented below the note's top level. */
  outline: string[];
  /** The section the passage sits in, whole, so the agent can see what its neighbours already say. */
  section: { heading: string | null; text: string } | null;
  /** Names, numbers and phrases in the passage that also appear elsewhere in the note. */
  keep: string[];
}

const OPENING_CHARS = 800;
const SECTION_CHARS = 6000;
const OUTLINE_HEADINGS = 40;
const KEEP_TERMS = 20;

/** Words a recurring phrase may not start or end with, or be made only of. */
const STOPWORDS = new Set(("a an and are as at be been but by can could did do does for from had has have how if in into is it its " +
  "may might more most must no not of on or our over so such than that the their them then there these they this those " +
  "through to too under up was we were what when where which while who why will with would you your").split(" "));
const CAPITALIZED = /[\p{Lu}][\p{L}\p{N}'’-]*(?:\s+[\p{Lu}][\p{L}\p{N}'’-]*)*/gu;
const NUMBER = /(?<![\p{L}\p{N}])\d[\d,.]*\+?%?/gu;
const WORD = /[\p{L}][\p{L}\p{N}'’-]*/gu;

function escape(term: string) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The term as a whole word or number, not part of a longer one. */
function occurs(text: string, term: string, caseSensitive: boolean) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, caseSensitive ? "u" : "iu").test(text);
}

/**
 * Terms in the passage the rest of the note also uses. Code finds them so the
 * model doesn't have to guess what later sections depend on: proper names and
 * acronyms (a capitalized word that only starts a sentence doesn't count),
 * numbers, and two- or three-word phrases that recur.
 */
export function sharedTerms(passage: string, rest: string, limit = KEEP_TERMS): string[] {
  const found = new Map<string, number>();
  const add = (term: string, weight: number) => {
    const trimmed = term.replace(/[’']s$/u, "").trim();
    if (trimmed.length > 1 && !found.has(trimmed)) found.set(trimmed, weight);
  };
  for (const match of passage.matchAll(CAPITALIZED)) {
    const term = match[0];
    const before = passage.slice(0, match.index).trimEnd();
    const startsSentence = !before || /[.!?:;\n]$/.test(before);
    const single = !/\s/.test(term);
    // A lone capital at a sentence's start is just grammar, unless it's an acronym.
    if (single && startsSentence && !/^\p{Lu}{2,}/u.test(term)) continue;
    if (single && STOPWORDS.has(term.toLowerCase())) continue;
    if (occurs(rest, term, true)) add(term, 3 + term.split(/\s+/).length);
  }
  for (const match of passage.matchAll(NUMBER)) {
    const number = match[0].replace(/[.,]$/, "");
    if (occurs(rest, number, true)) add(number, 3);
  }
  const words = [...passage.matchAll(WORD)].map((match) => match[0]);
  for (const size of [3, 2]) {
    for (let index = 0; index + size <= words.length; index++) {
      const phrase = words.slice(index, index + size);
      const lower = phrase.map((word) => word.toLowerCase());
      if (STOPWORDS.has(lower[0]) || STOPWORDS.has(lower[size - 1]) || lower.every((word) => STOPWORDS.has(word))) continue;
      const text = phrase.join(" ");
      if (occurs(rest, text, false)) add(text, size);
    }
  }
  // Longer terms first; a term inside one already kept adds nothing.
  const ranked = [...found.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).map(([term]) => term);
  const kept: string[] = [];
  for (const term of ranked) {
    if (kept.some((other) => occurs(other, term, false))) continue;
    kept.push(term);
    if (kept.length === limit) break;
  }
  return kept;
}

const NAME = /[\p{Lu}][\p{L}\p{N}'’-]*/gu;
const MAX_DROPPED = 8;

function count(text: string, term: string, caseSensitive = true) {
  return text.match(new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, caseSensitive ? "gu" : "giu"))?.length ?? 0;
}

/**
 * The facts an edit must not lose: numbers, and names (a capitalized word that
 * doesn't just start a sentence, or an acronym anywhere). Single words, so a
 * rephrased run of capitals doesn't read as a lost name.
 */
export function factsIn(text: string): string[] {
  const facts = new Set<string>();
  for (const match of text.matchAll(NUMBER)) {
    const number = match[0].replace(/[.,]+$/, "");
    if (number) facts.add(number);
  }
  for (const match of text.matchAll(NAME)) {
    const name = match[0].replace(/[’']s$/u, "");
    const before = text.slice(0, match.index).trimEnd();
    const startsSentence = !before || /[.!?:;\n]$/.test(before);
    if (name.length < 2 || STOPWORDS.has(name.toLowerCase())) continue;
    if (startsSentence && !/^\p{Lu}{2,}/u.test(name)) continue;
    facts.add(name);
  }
  return [...facts];
}

/**
 * What an edit dropped, checked by code rather than taken on the model's word:
 * a name or number from the edited text that the note no longer contains, or a
 * term the rest of the note relies on that it now mentions fewer times.
 */
export function droppedFacts(edited: string, before: string, after: string, keep: string[] = []): string[] {
  const dropped = factsIn(edited).filter((fact) => count(before, fact) > 0 && count(after, fact) === 0);
  for (const term of keep)
    if (!dropped.includes(term) && count(after, term, false) < count(before, term, false)) dropped.push(term);
  return dropped.slice(0, MAX_DROPPED);
}

function clip(text: string, limit: number) {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

export function noteMap(doc: ProseMirrorNode, title: string, range: { from: number; to: number }): NoteMap {
  const blocks: Array<{ from: number; to: number; level: number; text: string }> = [];
  doc.forEach((node, offset) => {
    blocks.push({
      from: offset,
      to: offset + node.nodeSize,
      level: node.type.name === "heading" ? Number(node.attrs.level) : 0,
      text: node.textContent.trim(),
    });
  });
  const opening = blocks.find((block) => !block.level && block.text)?.text ?? "";
  const headings = blocks.filter((block) => block.level && block.text).slice(0, OUTLINE_HEADINGS);
  const top = Math.min(...headings.map((block) => block.level));
  const outline = headings.map((block) => `${"  ".repeat(block.level - top)}${block.text}`);
  // The passage's section runs from the heading above it to the next heading at that level or higher.
  const first = blocks.findIndex((block) => block.to > range.from);
  let start = -1;
  for (let index = first; index >= 0; index--) {
    if (blocks[index].level && blocks[index].from < range.from) { start = index; break; }
  }
  let section: NoteMap["section"] = null;
  if (start >= 0) {
    const level = blocks[start].level;
    let end = start + 1;
    while (end < blocks.length && !(blocks[end].level && blocks[end].level <= level)) end++;
    section = {
      heading: blocks[start].text || null,
      text: clip(doc.textBetween(blocks[start].from, blocks[end - 1].to, "\n\n").trim(), SECTION_CHARS),
    };
  }
  const passage = doc.textBetween(range.from, range.to, "\n");
  const rest = `${doc.textBetween(0, range.from, "\n")}\n${doc.textBetween(range.to, doc.content.size, "\n")}`;
  return {
    title,
    opening: clip(opening, OPENING_CHARS),
    outline,
    section,
    keep: sharedTerms(passage, `${title}\n${rest}`),
  };
}
