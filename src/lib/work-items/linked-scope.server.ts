import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { hiddenProjectIds } from "@/lib/rbac/project-access";

/**
 * What a work-item READ may show of the items and sprint it is linked to.
 *
 * Writes now hold a parent to the item's own project and an interval to its
 * project (`foreign-refs.ts`). Rows written before that could point anywhere,
 * because the foreign keys are single-column: at a parent in another org, or in
 * a team-scoped project the reader can't open. Prisma can't filter a to-one
 * `include`, so a read would print that parent's title and ticket number, and
 * the parent's own list would show the planted item among its children.
 *
 * A linked item is shown when it is in the reader's org and in the same
 * project or one the reader can see; anything else reads as no link.
 */
async function visibleLinkedItemIds(
  ctx: AuthContext,
  orgId: string,
  projectId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await prisma.workItem.findMany({
    where: { id: { in: [...new Set(ids)] }, orgId },
    select: { id: true, projectId: true },
  });
  const elsewhere = rows.filter((r) => r.projectId !== projectId);
  // Only a cross-project link needs the visibility question asked at all.
  const hidden = elsewhere.length ? new Set(await hiddenProjectIds(ctx)) : new Set<string>();
  return new Set(rows.filter((r) => r.projectId === projectId || !hidden.has(r.projectId)).map((r) => r.id));
}

type Linked = {
  parent?: { id: string } | null;
  children?: { id: string }[];
  interval?: { id: string } | null;
  intervalId?: string | null;
};

/** `rows` with each out-of-scope parent, child and interval dropped (see above). */
export async function scopeItemLinks<T extends Linked>(
  ctx: AuthContext,
  orgId: string,
  projectId: string,
  rows: T[],
): Promise<T[]> {
  const linkIds = rows.flatMap((r) => [...(r.parent ? [r.parent.id] : []), ...(r.children ?? []).map((c) => c.id)]);
  const intervalIds = [...new Set(rows.flatMap((r) => (r.interval ? [r.interval.id] : [])))];
  if (linkIds.length === 0 && intervalIds.length === 0) return rows;

  const [items, intervals] = await Promise.all([
    visibleLinkedItemIds(ctx, orgId, projectId, linkIds),
    intervalIds.length
      ? prisma.interval
          .findMany({ where: { id: { in: intervalIds }, orgId, projectId }, select: { id: true } })
          .then((r) => new Set(r.map((i) => i.id)))
      : Promise.resolve(new Set<string>()),
  ]);
  return rows.map((r) => {
    const out = { ...r };
    if (r.parent && !items.has(r.parent.id)) out.parent = null;
    if (r.children) out.children = r.children.filter((c) => items.has(c.id));
    if (r.interval && !intervals.has(r.interval.id)) out.interval = null;
    return out;
  });
}
