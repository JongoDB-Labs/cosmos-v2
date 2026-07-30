/**
 * Human labels for work-item activity/history rows.
 *
 * Activities record field changes with the RAW stored value, and several fields
 * hold ids — `assigneeId` (a user id), `intervalId`, `workItemTypeId`, `parentId`.
 * Rendering `oldValue`/`newValue` verbatim therefore showed a bare GUID in the
 * item's Activity tab and the org Updates feed (e.g. "changed assigneeId from
 * <uuid> to <uuid>"). These helpers turn the raw field + value into readable
 * text: a friendly field name, and — for id-valued fields — the resolved
 * person / interval / type / status name.
 *
 * A raw id is never surfaced. Nor is a made-up one: an id the caller cannot
 * resolve yields NO label at all, so the phrase degrades to "changed interval"
 * rather than asserting "changed interval to Unknown" (BR: an interval change
 * read "changed interval to Unknown" on the Activity page because that feed
 * never wired an interval lookup — "Unknown" is a claim about the value, and we
 * don't have one). An unresolvable id has two indistinguishable causes here —
 * the target was deleted, or the caller's lookup table hasn't loaded yet — and
 * saying nothing is the only phrasing that is true in both.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIELD_LABELS: Record<string, string> = {
  assigneeId: "assignee",
  columnKey: "status",
  intervalId: "interval",
  workItemTypeId: "type",
  parentId: "parent",
  storyPoints: "story points",
  dueDate: "due date",
  startDate: "start date",
  columnEnteredAt: "column entered",
};

/** Friendly name for an activity's changed field (e.g. "assigneeId" → "assignee"). */
export function activityFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** Lookups from an id/key to a display name, wired from whatever the caller has. */
export interface ActivityValueResolvers {
  user?: (id: string) => string | undefined;
  interval?: (id: string) => string | undefined;
  type?: (id: string) => string | undefined;
  column?: (key: string) => string | undefined;
}

/**
 * Resolve a raw activity value to human-readable text for the given field.
 * Returns null when there is nothing honest to show — an empty value, or an
 * id-shaped value the resolvers can't name — and the caller then omits that
 * "from"/"to" clause entirely.
 */
export function activityValueLabel(
  field: string | null,
  value: string | null,
  resolvers: ActivityValueResolvers = {},
): string | null {
  if (value == null || value === "") return null;

  let resolved: string | undefined;
  switch (field) {
    case "assigneeId":
      resolved = resolvers.user?.(value);
      break;
    case "intervalId":
      resolved = resolvers.interval?.(value);
      break;
    case "workItemTypeId":
      resolved = resolvers.type?.(value);
      break;
    case "columnKey":
      // columnKey is a slug (e.g. "in_progress"), not a GUID — resolve to the
      // column's display name when known, else show the slug itself.
      return resolvers.column?.(value) ?? value;
    default:
      // Every other tracked field is a plain scalar (title, priority, points,
      // dates) — show it verbatim. Guard anyway: if a NEW id-valued field is
      // tracked upstream and nobody teaches this switch about it (`parentId` is
      // already labelled here but not yet recorded), it must fail closed rather
      // than leak a GUID into the feed.
      return UUID_RE.test(value) ? null : value;
  }

  if (resolved != null && resolved !== "") return resolved;
  // Unresolvable id: say nothing rather than leak the GUID or invent "Unknown".
  return null;
}
