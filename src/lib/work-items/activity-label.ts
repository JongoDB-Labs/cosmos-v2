/**
 * Human labels for work-item activity/history rows.
 *
 * Activities record field changes with the RAW stored value, and several fields
 * hold ids — `assigneeId` (a user id), `cycleId`, `workItemTypeId`, `parentId`.
 * Rendering `oldValue`/`newValue` verbatim therefore showed a bare GUID in the
 * item's Activity tab and the org Updates feed (e.g. "changed assigneeId from
 * <uuid> to <uuid>"). These helpers turn the raw field + value into readable
 * text: a friendly field name, and — for id-valued fields — the resolved
 * person / cycle / type / status name. A raw id is never surfaced: an
 * unresolved id-shaped value falls back to "Unknown".
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIELD_LABELS: Record<string, string> = {
  assigneeId: "assignee",
  columnKey: "status",
  cycleId: "cycle",
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
  cycle?: (id: string) => string | undefined;
  type?: (id: string) => string | undefined;
  column?: (key: string) => string | undefined;
}

/**
 * Resolve a raw activity value to human-readable text for the given field.
 * Returns null for an empty value (the caller omits the "from/to" clause).
 * Never returns a raw GUID — an unresolved id-shaped value becomes "Unknown".
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
    case "cycleId":
      resolved = resolvers.cycle?.(value);
      break;
    case "workItemTypeId":
      resolved = resolvers.type?.(value);
      break;
    case "columnKey":
      // columnKey is a slug (e.g. "in_progress"), not a GUID — resolve to the
      // column's display name when known, else show the slug itself.
      return resolvers.column?.(value) ?? value;
    default:
      return value;
  }

  if (resolved != null && resolved !== "") return resolved;
  // Unresolved id-valued field: never leak a raw GUID.
  return UUID_RE.test(value) ? "Unknown" : value;
}
