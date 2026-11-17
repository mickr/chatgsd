import { useMemo } from "react";
import type { Spec } from "@json-render/core";
import { AgentSpec } from "./ui/AgentSpec";
import { WritingOfferContext, type WritingOfferControls } from "./ui/writingOfferContext";
import { renderableSpec, splitReply } from "../../lib/agent/ui/content";

export type WritingOfferCardProps = WritingOfferControls;
export { WritingOfferContext, type WritingOfferControls } from "./ui/writingOfferContext";

/** Avoid a duplicate active card when the assistant has already placed it in its reply. */
export function hasWritingOfferCard(items: readonly { type: string; text?: string }[], id: string): boolean {
  return items.some(item => item.type === "text" && item.text && splitReply(item.text, false).some(segment => {
    if (segment.type !== "spec") return false;
    const spec = renderableSpec(segment.spec);
    if (!spec) return false;
    const visited = new Set<string>();
    const pending = [spec.root];
    while (pending.length) {
      const key = pending.pop()!;
      if (visited.has(key)) continue;
      visited.add(key);
      const element = spec.elements[key];
      if (!element) continue;
      if (element.type === "WritingSuggestion" && element.props.id === id) return true;
      pending.push(...element.children ?? []);
    }
    return false;
  }));
}

/** Both companion surfaces use the same catalog component and action authority. */
export function WritingOfferCard(props: WritingOfferCardProps) {
  const spec = useMemo<Spec>(() => ({
    root: "offer",
    elements: { offer: { type: "WritingSuggestion", props: { id: props.id }, children: [] } },
  }), [props.id]);
  return <WritingOfferContext.Provider value={props}>
    <AgentSpec spec={spec} />
  </WritingOfferContext.Provider>;
}
