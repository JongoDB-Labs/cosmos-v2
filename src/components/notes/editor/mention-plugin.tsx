"use client";

import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $createTextNode, type TextNode } from "lexical";
import { $createMentionNode } from "./mention-node";
import type { OrgUser } from "@/components/chat/mention-typeahead";
import { cn } from "@/lib/utils";

class MentionOption extends MenuOption {
  user: OrgUser;
  constructor(user: OrgUser) {
    super(user.id);
    this.user = user;
  }
}

/**
 * `@`-typeahead that inserts a MentionNode (which serializes back to the app's
 * `<@uuid>` token). Reuses the org-members list already loaded by the editor.
 */
export function MentionPlugin({ members }: { members: OrgUser[] }) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);

  // minLength 0 → opens on a bare "@"; matches the previous behaviour of
  // stopping the query at whitespace (names match on their first token).
  const triggerFn = useBasicTypeaheadTriggerMatch("@", {
    minLength: 0,
    maxLength: 75,
  });

  const options = useMemo(() => {
    const q = (query ?? "").toLowerCase();
    return members
      .filter((m) => !q || m.displayName.toLowerCase().includes(q))
      .slice(0, 8)
      .map((m) => new MentionOption(m));
  }, [members, query]);

  const onSelectOption = useCallback(
    (
      option: MentionOption,
      nodeToReplace: TextNode | null,
      closeMenu: () => void,
    ) => {
      editor.update(() => {
        const mention = $createMentionNode(
          option.user.id,
          option.user.displayName,
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
                className="z-50 max-h-56 w-56 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
              >
                {options.map((option, i) => (
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
                    <span className="truncate">{option.user.displayName}</span>
                  </li>
                ))}
              </ul>,
              anchorRef.current,
            )
          : null
      }
    />
  );
}
