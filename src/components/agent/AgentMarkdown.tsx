import { memo, useMemo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { CodeCopyButton } from "../ui";
import { errorMessage } from "../../services/agent";

function inline(text: string): ReactNode[] {
  const pattern =
    /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\*([^*]+)\*|_([^_]+)_|~~(.+?)~~|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const result: ReactNode[] = [];
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > start) result.push(text.slice(start, index));
    const key = `${index}`;
    if (match[1]) result.push(<code key={key}>{match[1]}</code>);
    else if (match[2] || match[3])
      result.push(<strong key={key}>{match[2] || match[3]}</strong>);
    else if (match[4] || match[5])
      result.push(<em key={key}>{match[4] || match[5]}</em>);
    else if (match[6]) result.push(<del key={key}>{match[6]}</del>);
    else
      result.push(
        <a
          key={key}
          href={match[8]}
          onClick={(event) => {
            event.preventDefault();
            void invoke("open_url_safe", { url: match[8] }).catch((error) =>
              toast.error(errorMessage(error)),
            );
          }}
        >
          {match[7]}
        </a>,
      );
    start = index + match[0].length;
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
}
function CodeBlock({ text }: { text: string }) {
  return (
    <div className="agent-panel-code">
      <CodeCopyButton text={text} className="absolute right-1 top-1" />
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
function parseMarkdown(text: string): ReactNode[] {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const key = index;
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const code: string[] = [];
      index++;
      while (
        index < lines.length &&
        !lines[index].trimStart().startsWith(fence[1])
      )
        code.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(<CodeBlock key={key} text={code.join("\n")} />);
      continue;
    }
    if (!line.trim()) {
      index++;
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      index++;
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading) {
      blocks.push(
        <p key={key} className="font-semibold">
          {inline(heading[1])}
        </p>,
      );
      index++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]))
        quote.push(lines[index++].replace(/^\s*>\s?/, ""));
      blocks.push(
        <blockquote key={key}>{inline(quote.join("\n"))}</blockquote>,
      );
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+/;
    const unordered = /^\s*[-*+]\s+/;
    const listPattern = ordered.test(line)
      ? ordered
      : unordered.test(line)
        ? unordered
        : null;
    if (listPattern) {
      const items: ReactNode[] = [];
      while (index < lines.length && listPattern.test(lines[index])) {
        items.push(
          <li key={index}>
            {inline(lines[index++].replace(listPattern, ""))}
          </li>,
        );
      }
      blocks.push(
        ordered.test(line) ? (
          <ol key={key}>{items}</ol>
        ) : (
          <ul key={key}>{items}</ul>
        ),
      );
      continue;
    }
    blocks.push(<p key={key}>{inline(line)}</p>);
    index++;
  }
  return blocks;
}
export const AgentMarkdown = memo(function AgentMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const content = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="agent-panel-markdown">
      {content}
      {streaming && <span className="agent-panel-caret" aria-label="Writing" />}
    </div>
  );
});
