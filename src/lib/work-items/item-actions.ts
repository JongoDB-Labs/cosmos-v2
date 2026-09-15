import { Link2, Archive, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";
import type { ActionMenuItem } from "@/components/ui/action-menu";
import { entityUrl } from "@/lib/mentions/urls";

/**
 * The two actions every work-item card and row should offer, built once.
 *
 * Both were reported the same week, and both reports were really about reach
 * rather than about the action itself:
 *
 *  - **Copy link** existed only on the Issues list and the roadmap. From a
 *    board there was no way to get a link to a ticket at all — the reporter
 *    ended up reading the internal id out of network traffic.
 *  - **Archive** did not exist. Deleting is ADMIN-only on purpose, so a member
 *    who created five duplicates by accident could not clear them up, and
 *    settled for RENAMING them to say "duplicate" — which leaves the clutter
 *    and adds noise.
 *
 * Built here rather than per surface for the reason the mention-token strip
 * taught us the hard way: seven copies of a rule is seven places for it to be
 * subtly different, and the eighth surface copies whichever neighbour it finds.
 * `ActionMenuItem` is imported as a TYPE, so this adds no runtime dependency on
 * a component.
 */

/** Just enough of a work item for these two actions. */
export interface ActionableItem {
  id: string;
  /** Null/undefined when active. */
  archivedAt?: string | null;
}

/**
 * "Copy link" — a deep link to THIS ticket, not the project it lives in.
 *
 * `entityUrl` is the shared builder the mention chips, home widgets and
 * dependency map already use, so every deep link in the product has one
 * definition and they cannot drift.
 */
export function copyLinkAction(
  item: { id: string; ticketKey?: string | null },
  orgSlug: string | null | undefined,
  label = "Copy link",
): ActionMenuItem[] {
  // No org in the URL means no link to build. Returning no row beats returning
  // one that silently does nothing when clicked — `ActionMenu` already drops
  // empty groups, so the menu simply does not grow a dead entry.
  if (!orgSlug) return [];
  return [{
    label,
    icon: Link2,
    onClick: () => {
      // Prefer the TICKET KEY over the uuid. A link is something a person reads
      // in Slack and, increasingly often, retypes — ".../issues?item=ACME-320"
      // says which ticket before anyone clicks it, and a uuid says nothing at
      // all. The deep-link route resolves either, so nothing is lost: an older
      // link with a uuid keeps working.
      const ref = item.ticketKey?.trim() || item.id;
      const href = entityUrl("workItem", { orgSlug, id: ref });
      if (!href) return;
      try {
        void navigator.clipboard?.writeText(`${window.location.origin}${href}`);
        toast.success("Issue link copied");
      } catch {
        /* clipboard unavailable (insecure origin, or denied) — no toast lies */
      }
    },
  }];
}

/**
 * "Archive" / "Restore", depending on where the item already is.
 *
 * One row that flips rather than two that are conditionally shown: the reader
 * is looking at one item whose state they can see, and a menu offering both at
 * once has to be read before it can be used.
 *
 * `canEdit` is ITEM_UPDATE, deliberately — not ITEM_DELETE. Archiving is
 * reversible, which is exactly what lets it sit at a lower bar than deletion
 * instead of being a softer name for it.
 */
export function archiveAction({
  item,
  canEdit,
  pending = false,
  onToggle,
}: {
  item: ActionableItem;
  canEdit: boolean;
  pending?: boolean;
  /** Receives the new value: an ISO timestamp to archive, null to restore. */
  onToggle: (archivedAt: string | null) => void;
}): ActionMenuItem[] {
  if (!canEdit) return [];
  const archived = !!item.archivedAt;
  return [
    {
      label: archived ? "Restore from archive" : "Archive",
      icon: archived ? ArchiveRestore : Archive,
      disabled: pending,
      onClick: () => onToggle(archived ? null : new Date().toISOString()),
    },
  ];
}
