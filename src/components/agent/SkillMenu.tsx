import { memo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, flip, offset, shift, size, useFloating } from "@floating-ui/react-dom";
import type { Skill } from "../../services/agent";

/** Space kept between the menu and the window's edges. */
const EDGE_PADDING = 8;
/** Gap between the composer and the menu. */
const ANCHOR_GAP = 6;
/** Tallest the menu grows before it scrolls, when the window has room for it. */
const MAX_HEIGHT = 280;
/** Below this the menu would be cramped above the composer, so it opens below instead. */
const MIN_HEIGHT = 120;

export const skillOptionId = (listId: string, index: number) => `${listId}-${index}`;

/** The skill's name with the part matching the query marked. */
function SkillName({ name, query }: { name: string; query: string }) {
  const start = query ? name.indexOf(query.toLowerCase()) : -1;
  if (start < 0) return <>/{name}</>;
  return (
    <>
      /{name.slice(0, start)}
      <mark>{name.slice(start, start + query.length)}</mark>
      {name.slice(start + query.length)}
    </>
  );
}

/**
 * The skills the composer's leading `/command` can complete to. It floats
 * beside the composer, above it unless there isn't room, matching its width
 * and shrinking to the space the window has. Focus never leaves the composer:
 * the composer drives the highlight with the arrow keys, and rows take the
 * pointer without taking focus.
 */
export const SkillMenu = memo(function SkillMenu({
  anchor,
  id,
  skills,
  query,
  active,
  empty,
  onHighlight,
  onPick,
}: {
  anchor: HTMLElement | null;
  id: string;
  skills: Skill[];
  query: string;
  active: number;
  /** Shown in place of the list when nothing matches. */
  empty: string;
  onHighlight: (index: number) => void;
  onPick: (name: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const { refs, floatingStyles, placement, isPositioned } = useFloating({
    elements: { reference: anchor },
    placement: "top-start",
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(ANCHOR_GAP),
      flip({ padding: EDGE_PADDING, fallbackPlacements: ["bottom-start"] }),
      shift({ padding: EDGE_PADDING }),
      size({
        padding: EDGE_PADDING,
        apply({ availableHeight, rects, elements }) {
          elements.floating.style.width = `${rects.reference.width}px`;
          elements.floating.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, availableHeight))}px`;
        },
      }),
    ],
  });
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active, skills]);
  return createPortal(
    <div
      ref={refs.setFloating}
      className="agent-skill-menu"
      data-side={placement.startsWith("bottom") ? "bottom" : "top"}
      data-positioned={isPositioned || undefined}
      style={floatingStyles}
    >
      <div className="agent-skill-menu-label" aria-hidden="true">Skills</div>
      <div ref={list} id={id} role="listbox" aria-label="Skills" className="agent-skill-menu-list">
        {skills.length === 0 ? (
          <p className="agent-skill-menu-empty">{empty}</p>
        ) : skills.map((skill, index) => (
          <div
            key={skill.name}
            id={skillOptionId(id, index)}
            role="option"
            aria-selected={index === active}
            className="agent-skill-menu-item"
            // Keeps focus, and the caret, in the composer.
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => { if (index !== active) onHighlight(index); }}
            onClick={() => onPick(skill.name)}
          >
            <span className="agent-skill-menu-name"><SkillName name={skill.name} query={query} /></span>
            {skill.description && <span className="agent-skill-menu-description">{skill.description}</span>}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
});
