/**
 * Which SHARED saved views a viewer may see.
 *
 * A shared view is a definition, not a grant: running it is already safe,
 * because every query is hard-scoped to `getReadableProjectIds`. Listing it is
 * not. Its stored filter names projects, sprints, parent items and custom
 * fields by id, and the Issues view turns those into labels, so a view shared
 * org-wide by someone on a team-scoped project used to hand every member the
 * fact (and, once applied, the names) of things they cannot read.
 *
 * Rule: a view owned by someone else is listed only if EVERY project-bound
 * entity its filter references lives in a project the viewer can read. An id
 * that resolves to nothing (deleted since) is not a disclosure and does not
 * hide the view. Org-level entities (types, labels, org-wide custom fields,
 * status keys, users) carry no project and never hide a view.
 *
 * DB-backed but batched: one query per entity kind for the whole list.
 */
import { prisma } from "@/lib/db/client";
import { isUuid } from "@/lib/ids";

/** The project-bound ids a stored (loosely typed) WorkItemFilter references. */
export interface FilterRefs {
  projectIds: string[];
  intervalIds: string[];
  itemIds: string[];
  customFieldKeys: string[];
}

/** Uuid-shaped strings only. Anything else cannot name a row (and would make
 *  Postgres reject the whole `IN` lookup), so it discloses nothing. */
function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter(isUuid) : [];
}

/**
 * Pull the project-bound references out of a stored filter. Defensive: the
 * column is `Json` and older rows were validated loosely, so every field is
 * checked for shape rather than trusted.
 */
export function filterRefs(filter: unknown): FilterRefs {
  const f = (filter && typeof filter === "object" ? filter : {}) as Record<string, unknown>;
  const parent = (f.parent && typeof f.parent === "object" ? f.parent : {}) as Record<string, unknown>;
  const customFields = Array.isArray(f.customFields) ? f.customFields : [];
  return {
    projectIds: ids(f.projectIds),
    // The "none" no-sprint sentinel is not uuid-shaped, so ids() drops it.
    intervalIds: ids(f.intervalIds),
    itemIds: [...ids(f.ids), ...(parent.mode === "is" ? ids(parent.parentIds) : [])],
    customFieldKeys: customFields
      .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>).key : undefined))
      .filter((k): k is string => typeof k === "string" && k !== ""),
  };
}

/**
 * Pure decision: are all of `refs` inside `readable`? `projectOf*` map an
 * entity to its owning project; a missing entry means the entity is gone (or
 * org-level, for custom fields) and is ignored.
 */
export function refsReadable(
  refs: FilterRefs,
  readable: ReadonlySet<string>,
  lookup: {
    intervalProject: ReadonlyMap<string, string>;
    itemProject: ReadonlyMap<string, string>;
    customFieldProject: ReadonlyMap<string, string | null>;
  },
): boolean {
  const ok = (projectId: string | null | undefined) => projectId == null || readable.has(projectId);
  return (
    refs.projectIds.every((id) => readable.has(id))
    && refs.intervalIds.every((id) => ok(lookup.intervalProject.get(id)))
    && refs.itemIds.every((id) => ok(lookup.itemProject.get(id)))
    && refs.customFieldKeys.every((k) => ok(lookup.customFieldProject.get(k)))
  );
}

/**
 * Keep the views `viewerId` may see listed: their own, plus shared views whose
 * references are all readable. Order is preserved.
 */
export async function visibleSavedViews<V extends { ownerId: string; filter: unknown }>(
  orgId: string,
  viewerId: string,
  readableProjectIds: readonly string[],
  views: V[],
): Promise<V[]> {
  const foreign = views.filter((v) => v.ownerId !== viewerId);
  if (foreign.length === 0) return views;

  const refsByView = new Map(foreign.map((v) => [v, filterRefs(v.filter)]));
  const all = [...refsByView.values()];
  const intervalIds = [...new Set(all.flatMap((r) => r.intervalIds))];
  const itemIds = [...new Set(all.flatMap((r) => r.itemIds))];
  const cfKeys = [...new Set(all.flatMap((r) => r.customFieldKeys))];

  const [intervals, items, fields] = await Promise.all([
    intervalIds.length
      ? prisma.interval.findMany({
          where: { orgId, id: { in: intervalIds } },
          select: { id: true, projectId: true },
        })
      : [],
    itemIds.length
      ? prisma.workItem.findMany({
          where: { orgId, id: { in: itemIds } },
          select: { id: true, projectId: true },
        })
      : [],
    cfKeys.length
      ? prisma.customField.findMany({
          where: { orgId, key: { in: cfKeys } },
          select: { key: true, projectId: true },
        })
      : [],
  ]);

  const readable = new Set(readableProjectIds);
  const lookup = {
    intervalProject: new Map(intervals.map((i) => [i.id, i.projectId])),
    itemProject: new Map(items.map((i) => [i.id, i.projectId])),
    customFieldProject: new Map(fields.map((c) => [c.key, c.projectId])),
  };
  return views.filter(
    (v) => v.ownerId === viewerId || refsReadable(refsByView.get(v)!, readable, lookup),
  );
}
