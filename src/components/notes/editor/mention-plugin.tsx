"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $createTextNode, type TextNode } from "lexical";
import { $createMentionNode } from "./mention-node";
import { useEntitySearch } from "@/components/mentions/hooks";
import { ENTITY_ICON } from "@/lib/mentions/registry.client";
import type { ResolvedEntity } from "@/lib/mentions/refs";
import { cn } from "@/lib/utils";

/** The popup's resting height. */
const MENU_MAX_HEIGHT = 256;
/** Below this there is no usable list; flip above the caret instead. */
const MENU_MIN_HEIGHT = 96;

class MentionOption extends MenuOption {
  hit: ResolvedEntity;
  constructor(hit: ResolvedEntity) {
    super(`${hit.type}:${hit.id}`);
    this.hit = hit;
  }
}

/**
 * The typeahead popup.
 *
 * Its own component so it can measure itself in a layout effect. The
 * alternative — mirroring Lexical's anchor ref into the plugin's state from
 * inside `menuRenderFn` — would be a setState during ANOTHER component's
 * render, which React rejects outright.
 *
 * ## Two defects this element carried
 *
 * **It was unclickable.** The class list was `z-50` on an element with the
 * default `position: static`, and `z-index` does nothing to an unpositioned box
 * — so the popup had no stacking order of its own. Lexical appends its anchor
 * (`#typeahead-menu`) to `<body>` with `z-index: auto`, while the card detail
 * sheet is `position: fixed; z-index: 50` in the same root stacking context.
 * The sheet therefore painted on top: `document.elementFromPoint` at an
 * option's centre returned the comment editor, not the option.
 *
 * The consequence was the reported bug. A click aimed at a person landed in the
 * editor instead, so no MentionNode was ever inserted — the literal `@Name`
 * text stayed in the box, the `@`-trigger kept matching it, and the popup
 * re-appeared on every subsequent keystroke ("the @name starts repeatedly
 * showing up with each keystroke"). It also meant a mouse user could not
 * mention anyone in a comment at all, and the plain text that got submitted
 * carried no `<@uuid>` token, so the person was never notified.
 *
 * **It opened off the bottom of the screen.** Lexical only ever opens downward.
 * The comment composer sits at the foot of a full-height sheet, so the caret is
 * routinely within ~40px of the viewport floor and a 256px list ran straight
 * past it.
 */
function MentionMenu({
  options,
  selectedIndex,
  onHighlight,
  onPick,
}: {
  options: MentionOption[];
  selectedIndex: number | null;
  onHighlight: (i: number) => void;
  onPick: (option: MentionOption) => void;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const [placement, setPlacement] = useState<{ flip: boolean; maxHeight: number }>({
    flip: false,
    maxHeight: MENU_MAX_HEIGHT,
  });

  // Measured off the ANCHOR (this element's portal parent, which Lexical moves
  // to the caret), not off this element — its own position is what we are
  // deciding here, so reading it would be circular.
  useLayoutEffect(() => {
    const anchor = ref.current?.parentElement;
    if (!anchor) return;
    const measure = () => {
      const { top, bottom } = anchor.getBoundingClientRect();
      const below = window.innerHeight - bottom;
      const above = top;
      // Flip only when below is genuinely too tight AND above is roomier;
      // flipping into an even smaller gap just moves the problem.
      const flip = below < MENU_MIN_HEIGHT && above > below;
      const room = flip ? above : below;
      setPlacement({
        flip,
        maxHeight: Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, room - 8)),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // The anchor moves as the list grows and shrinks with the query.
  }, [options.length]);

  return (
    <ul
      ref={ref}
      role="listbox"
      // `absolute` so the z-index applies at all, and z-[60] to clear the
      // sheet/dialog layer (both z-50). See this component's doc comment.
      className="absolute z-[60] w-72 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{
        maxHeight: placement.maxHeight,
        ...(placement.flip
          ? { bottom: "100%", marginBottom: 4 }
          : { marginTop: 4 }),
      }}
    >
      {options.map((option, i) => {
        const Icon = ENTITY_ICON[option.hit.type];
        return (
          <li
            key={option.key}
            role="option"
            aria-selected={selectedIndex === i}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
              selectedIndex === i && "bg-accent text-accent-foreground",
            )}
            onMouseEnter={() => onHighlight(i)}
            // mousedown, not click: the editor takes focus back on mouseup and
            // collapses the selection before a click handler would ever run.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(option);
            }}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{option.hit.label}</span>
            {option.hit.sublabel && (
              <span className="ml-auto pl-2 text-xs text-muted-foreground truncate max-w-[40%]">
                {option.hit.sublabel}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * `@`-typeahead that searches ALL entity types (shared index) and inserts a
 * typed MentionNode (which serializes to `<@uuid>` for people / `<@type:id>`
 * for everything else).
 */
export function MentionPlugin({ orgId }: { orgId: string }) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);

  const triggerFn = useBasicTypeaheadTriggerMatch("@", {
    minLength: 0,
    maxLength: 75,
  });

  const { data } = useEntitySearch(orgId, query ?? "");
  const options = (data ?? []).slice(0, 12).map((h) => new MentionOption(h));

  const onSelectOption = useCallback(
    (
      option: MentionOption,
      nodeToReplace: TextNode | null,
      closeMenu: () => void,
    ) => {
      editor.update(() => {
        const mention = $createMentionNode(
          option.hit.type,
          option.hit.id,
          option.hit.label,
        );
        if (nodeToReplace) nodeToReplace.replace(mention);
        // trailing space so the caret leaves the atomic token
        const space = $createTextNode(" ");
        mention.insertAfter(space);
        space.select();
        closeMenu();
      });
    },
    [editor],
  );

  return (
    <LexicalTypeaheadMenuPlugin<MentionOption>
      options={options}
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      triggerFn={triggerFn}
      menuRenderFn={(
        anchorRef,
        { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex },
      ) =>
        anchorRef.current && options.length > 0
          ? createPortal(
              <MentionMenu
                options={options}
                selectedIndex={selectedIndex}
                onHighlight={setHighlightedIndex}
                onPick={selectOptionAndCleanUp}
              />,
              anchorRef.current,
            )
          : null
      }
    />
  );
}
