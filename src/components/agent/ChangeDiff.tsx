import { useEffect, useRef } from "react";
import type { FileDiff } from "@pierre/diffs";

/** Both the gutter popover and saved turns use the same read-only renderer. */
export function mountChangeDiff(container: HTMLElement, before: string, after: string, name: string) {
  let disposed = false;
  let viewer: FileDiff | undefined;
  container.textContent = "Loading diff…";
  void import("@pierre/diffs").then(({ FileDiff }) => {
    if (disposed) return;
    container.textContent = "";
    viewer = new FileDiff({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: document.documentElement.classList.contains("dark") ? "dark" : "light",
      diffStyle: "unified",
      lineDiffType: "word-alt",
      diffIndicators: "classic",
      disableFileHeader: true,
      disableLineNumbers: true,
      overflow: "wrap",
      hunkSeparators: "line-info-basic",
    });
    viewer.render({
      // These are passage excerpts, not files. Omit end-of-file newline warnings.
      oldFile: { name: `${name}.md`, contents: before && !before.endsWith("\n") ? `${before}\n` : before, lang: "markdown" },
      newFile: { name: `${name}.md`, contents: after && !after.endsWith("\n") ? `${after}\n` : after, lang: "markdown" },
      containerWrapper: container,
    });
  }).catch((error: unknown) => {
    if (!disposed) container.textContent = `Couldn't show this diff: ${error instanceof Error ? error.message : String(error)}`;
  });
  return () => { disposed = true; viewer?.cleanUp(); };
}

export function ChangeDiff({ before, after, name }: { before: string; after: string; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) return mountChangeDiff(ref.current, before, after, name);
  }, [before, after, name]);
  return <div ref={ref} className="agent-change-diff" />;
}
