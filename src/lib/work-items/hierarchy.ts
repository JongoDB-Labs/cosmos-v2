import type { PrismaClient } from "@prisma/client";

// Canonical hierarchy depth by BARE type key (the segment after the sector
// prefix, e.g. "software.task" → "task"). Mirrors `childTypeFor` in the card
// detail sheet: epic > story > task/bug > subtask. A parent must sit strictly
// ABOVE its child in this ranking, so a Story can nest under an Epic and a
// Subtask under a Task, but never the reverse.
//
// Types outside this map (custom org types, other sectors) have no opinion here
// and skip the rank check — only the structural rules (not-self, same-project,
// no-cycle) apply to them. That keeps the guard from rejecting legitimate
// hierarchies we don't model.
const TYPE_RANK: Record<string, number> = {
  epic: 0,
  story: 1,
  task: 2,
  bug: 2,
  subtask: 3,
};

/** Strip the sector prefix from a work-item-type key: "software.task" → "task". */
export function bareTypeKey(key: string | null | undefined): string | null {
  if (!key) return null;
  return key.split(".").pop()?.toLowerCase() ?? null;
}

/**
 * Is `childTypeKey` allowed to be a child of `parentTypeKey`? True when the
 * parent ranks strictly higher (lower number) in the known hierarchy. Unknown
 * types (either side) return true — we only enforce the rank where we model it.
 */
export function isTypeNestingValid(
  parentTypeKey: string | null | undefined,
  childTypeKey: string | null | undefined,
): boolean {
  const parentRank = TYPE_RANK[bareTypeKey(parentTypeKey) ?? ""];
  const childRank = TYPE_RANK[bareTypeKey(childTypeKey) ?? ""];
  if (parentRank === undefined || childRank === undefined) return true;
  return childRank > parentRank;
}

/** A client-facing validation failure: HTTP status + human-readable reason. */
export type ParentValidationError = { status: number; error: string };

type HierarchyDb = Pick<PrismaClient, "workItem" | "workItemType">;

/**
 * Validate a proposed parent link for a work item before it is written.
 *
 * The parent picker in the UI only filters out the item's *direct* children, so
 * the server owns the deeper integrity rules this enforces:
 *   1. Parent exists inside the SAME org + project (no cross-project nesting).
 *   2. An item can't be its own parent.
 *   3. No circular reference — the proposed parent must not already be a
 *      descendant of the item (walk the parent's ancestor chain looking for it).
 *   4. Type compatibility — a child type can't nest under an incompatible parent
 *      type (e.g. an Epic under a Story). See `isTypeNestingValid`.
 *
 * Returns `null` when the link is valid, or a `ParentValidationError` describing
 * the first rule violated. `childId` is null for a not-yet-created item (create
 * path) — a brand-new item has no descendants, so the cycle walk is skipped.
 */
export async function validateParentAssignment(args: {
  db: HierarchyDb;
  orgId: string;
  projectId: string;
  parentId: string;
  childId: string | null;
  childTypeId: string;
}): Promise<ParentValidationError | null> {
  const { db, orgId, projectId, parentId, childId, childTypeId } = args;

  // (2) An item can't be its own parent.
  if (childId && parentId === childId) {
    return { status: 400, error: "An item can't be its own parent." };
  }

  // (1) Parent must exist in the same org + project.
  const parent = await db.workItem.findFirst({
    where: { id: parentId, orgId, projectId },
    select: { id: true, parentId: true, workItemType: { select: { key: true, name: true } } },
  });
  if (!parent) {
    return { status: 400, error: "Parent item not found in this project." };
  }

  // (3) Circular reference: walk UP from the proposed parent. If the item we're
  // re-parenting appears anywhere in that ancestor chain, linking would loop.
  if (childId) {
    let cursor: string | null = parent.parentId;
    const seen = new Set<string>([parentId]);
    while (cursor) {
      if (cursor === childId) {
        return { status: 400, error: "That would create a circular parent/child relationship." };
      }
      if (seen.has(cursor)) break; // defensive: don't spin on pre-existing data cycles
      seen.add(cursor);
      const ancestor: { parentId: string | null } | null = await db.workItem.findUnique({
        where: { id: cursor },
        select: { parentId: true },
      });
      cursor = ancestor?.parentId ?? null;
    }
  }

  // (4) Type compatibility.
  const childType = await db.workItemType.findUnique({
    where: { id: childTypeId },
    select: { key: true, name: true },
  });
  if (!isTypeNestingValid(parent.workItemType?.key, childType?.key)) {
    const childName = childType?.name ?? "item";
    const parentName = parent.workItemType?.name ?? "item";
    return {
      status: 400,
      error: `A ${childName} can't be nested under a ${parentName}.`,
    };
  }

  return null;
}
