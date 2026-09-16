// src/lib/classification/effective.ts
import { prisma } from "@/lib/db/client";
import { isUuid } from "@/lib/ids";
import type { ClassificationLevel } from "@prisma/client";

const ORDER: ClassificationLevel[] = ["PUBLIC", "UNCLASSIFIED", "FOUO", "CUI", "CONFIDENTIAL"];

export function rankOf(level: ClassificationLevel): number {
  return ORDER.indexOf(level);
}

/**
 * The HIGHER-rank (more-restrictive) of two ceilings; `extra` may be null (adds no
 * floor — returns `base`). Used by the agent loop to FOLD a resolved opaque handle's
 * mint-time ceiling into a result's effective gate ceiling (C1): resolving a handle
 * minted under a high ceiling forces the resolving turn's result to be gated at ≥ that
 * ceiling, so a high-ceiling value can never be echoed back under a lower per-turn
 * ceiling. This only ever RAISES the ceiling (allow→deny), never lowers it.
 */
export function maxByRank(
  base: ClassificationLevel,
  extra: ClassificationLevel | null,
): ClassificationLevel {
  if (extra === null) return base;
  return rankOf(extra) > rankOf(base) ? extra : base;
}

/**
 * The effective classification CEILING for a value: max(org-ceiling row, project row).
 * Org ceiling = the DataClassification row with projectId = null. Default UNCLASSIFIED
 * (conservative — NOT public) when nothing is set. This is the MAC input to the gate.
 *
 * `projectId` may arrive from MODEL input — the agent loop reads it straight off a
 * tool call's arguments — and the model does not always send a real one: it will
 * invent a readable-looking id when it never looked the project up. This is the one
 * place that id crosses into `DataClassification.projectId`, a `@db.Uuid` column, so
 * an invented id raised Prisma P2007 (`invalid input syntax for type uuid`) HERE,
 * after the tool had already returned and outside anything the tool could catch —
 * which is how a chat asking for sprint data ended in a raw database error.
 *
 * A non-uuid is therefore dropped from the predicate rather than queried. That does
 * not lower the ceiling: `projectId` is a uuid column, so no project can hold an id
 * of that shape, and the per-project row could never have matched. The result is the
 * org row alone — exactly what Postgres returns for any id no project has. The
 * predicate is only ever omitted where it was already guaranteed to miss.
 */
export async function effectiveCeiling(
  orgId: string,
  projectId?: string | null,
): Promise<ClassificationLevel> {
  const rows = await prisma.dataClassification.findMany({
    where: {
      orgId,
      OR: isUuid(projectId)
        ? [{ projectId: null }, { projectId }]
        : [{ projectId: null }],
    },
    select: { projectId: true, level: true },
  });
  let max: ClassificationLevel = "UNCLASSIFIED";
  for (const r of rows) if (rankOf(r.level) > rankOf(max)) max = r.level;
  return max;
}
