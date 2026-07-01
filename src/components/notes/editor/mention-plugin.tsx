"use client";

import { useCallback, useState } from "react";
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

class MentionOption extends MenuOption {
  hit: ResolvedEntity;
  constructor(hit: ResolvedEntity) {
    super(`${hit.type}:${hit.id}`);
    this.hit = hit;
  }
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
      menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorRef.current && options.length > 0
          ? createPortal(
              <ul
                role="listbox"
                className="z-50 max-h-64 w-72 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
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
                      onMouseEnter={() => setHighlightedIndex(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectOptionAndCleanUp(option);
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
              </ul>,
              anchorRef.current,
            )
          : null
      }
    />
  );
}
