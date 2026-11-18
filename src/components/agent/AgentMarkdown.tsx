import { memo, useMemo, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Markdown } from "@pierre/words/react";
import { createHighlightsPlugin } from "@pierre/words/highlights";
import pierreDark from "@pierre/highlights/themes/pierre-dark";
import pierreLight from "@pierre/highlights/themes/pierre-light";
import { errorMessage } from "../../services/agent";
import { renderableSpec, splitReply } from "../../lib/agent/ui/content";
import { AgentSpec } from "./ui/AgentSpec";

const plugins = {
  code: createHighlightsPlugin({
    themes: { light: pierreLight, dark: pierreDark },
    defaultColor: false,
  }),
};
const controls = { code: { copy: true, download: false } };
/** Replies never load remote images; the CSP would block them anyway. */
const disallowedElements = ["img"];

function setCopyLabel(button: HTMLButtonElement, label: string) {
  if (button.isConnected) button.textContent = label;
}

/** Links and Copy go through Tauri commands; the webview's own handling is unreliable. */
function handleClick(event: MouseEvent<HTMLDivElement>) {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest("a[href]");
  if (link) {
    event.preventDefault();
    const url = link.getAttribute("href") ?? "";
    if (/^https?:\/\//.test(url))
      void invoke("open_url_safe", { url }).catch((error) =>
        toast.error(errorMessage(error)),
      );
    return;
  }
  const button = event.target.closest<HTMLButtonElement>(
    'button[data-code-action="copy"]',
  );
  if (!button) return;
  event.stopPropagation();
  const block = button.closest<HTMLElement>('[data-markdown="code-block"]');
  const text =
    block?.dataset.code ?? block?.querySelector("pre code")?.textContent ?? "";
  void invoke("copy_to_clipboard", { text })
    .then(() => {
      setCopyLabel(button, "Copied");
      window.setTimeout(() => setCopyLabel(button, "Copy"), 1500);
    })
    .catch((error) => toast.error(errorMessage(error)));
}

function Prose({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <Markdown
      className="agent-panel-prose"
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      animated={streaming}
      plugins={plugins}
      controls={controls}
      lineNumbers={false}
      disallowedElements={disallowedElements}
      math
      onClickCapture={handleClick}
    >
      {text}
    </Markdown>
  );
}
/** User-written markdown (a selection, say): rendered as written, with no UI blocks. */
export const MarkdownPreview = memo(function MarkdownPreview({
  text,
}: {
  text: string;
}) {
  return (
    <div className="agent-panel-markdown">
      <Prose text={text} />
    </div>
  );
});
export const AgentMarkdown = memo(function AgentMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const content = useMemo(
    () =>
      splitReply(text, streaming).map((segment, index, segments) => {
        if (segment.type === "text")
          return (
            <Prose
              key={index}
              text={segment.text}
              streaming={streaming && index === segments.length - 1}
            />
          );
        const spec = renderableSpec(segment.spec);
        if (spec)
          return (
            <AgentSpec key={index} spec={spec} loading={!segment.complete} />
          );
        return segment.complete ? (
          <p key={index} className="text-xs text-text-muted">
            This view couldn't be displayed.
          </p>
        ) : null;
      }),
    [text, streaming],
  );
  return (
    <div className="agent-panel-markdown">
      {content}
      {streaming && <span className="agent-panel-caret" aria-label="Writing" />}
    </div>
  );
});
