/** One replacement, narrowed to the words that actually differ. */
export interface InlineDiff {
  prefix: string;
  removed: string;
  added: string;
  suffix: string;
}

/**
 * Trims the words shared at the start and end of a replacement, so a preview
 * marks only what changed: "Rain jacket" → "Rain jacket and umbrella" shows
 * " and umbrella" as the addition. Whitespace runs count as words, so the
 * pieces always join back to the original strings.
 */
export function inlineDiff(removed: string, added: string): InlineDiff {
  const before = removed.split(/(\s+)/);
  const after = added.split(/(\s+)/);
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  return {
    prefix: before.slice(0, start).join(""),
    removed: before.slice(start, before.length - end).join(""),
    added: after.slice(start, after.length - end).join(""),
    suffix: before.slice(before.length - end).join(""),
  };
}
