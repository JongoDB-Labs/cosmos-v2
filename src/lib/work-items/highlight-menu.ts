import type { ActionMenuGroup } from "@/components/ui/action-menu";
import {
  WORK_ITEM_HIGHLIGHTS,
  WORK_ITEM_HIGHLIGHT_ORDER,
  isWorkItemHighlight,
  type WorkItemHighlight,
} from "./highlights";

/**
 * The "Highlight" submenu, built once for every card surface that has a
 * right-click menu.
 *
 * One builder rather than a copy per board: the palette, the order, the "Clear"
 * escape hatch and the checkmark on the current value all have to agree, and a
 * menu that offers five colours on Kanban and six on the backlog is the exact
 * drift the shared `matchesFilters` extraction exists to prevent.
 *
 * `ActionMenuGroup` is imported as a TYPE, so this adds no runtime dependency on
 * a component — the same arrangement `board-filters.ts` uses for `BoardFilters`.
 *
 * Returns a group whose `items` is EMPTY when the caller cannot edit. That is
 * the contract `ActionMenu` already relies on: it filters empty groups out, and
 * hides itself entirely when every group is empty, so a read-only viewer sees
 * no dead submenu.
 */
export function highlightMenuGroup({
  current,
  onPick,
  canEdit = true,
  disabled = false,
}: {
  /** The item's stored value. Anything unrecognised reads as "no highlight". */
  current: string | null | undefined;
  /** `null` clears it. */
  onPick: (next: WorkItemHighlight | null) => void;
  canEdit?: boolean;
  /** True while a save is in flight. */
  disabled?: boolean;
}): ActionMenuGroup {
  if (!canEdit) return { label: "Highlight", items: [] };

  const active = isWorkItemHighlight(current) ? current : null;

  return {
    label: "Highlight",
    items: [
      ...WORK_ITEM_HIGHLIGHT_ORDER.map((key) => ({
        label: WORK_ITEM_HIGHLIGHTS[key].label,
        swatch: `var(${WORK_ITEM_HIGHLIGHTS[key].cssVar})`,
        checked: active === key,
        disabled,
        onClick: () => onPick(key),
      })),
      // Offered only when there is something to clear. A permanently-present
      // "None" row would read as a seventh colour.
      ...(active
        ? [{ label: "Clear highlight", disabled, onClick: () => onPick(null) }]
        : []),
    ],
  };
}
