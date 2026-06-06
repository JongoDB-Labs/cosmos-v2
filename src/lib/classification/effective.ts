// src/lib/classification/effective.ts
import { prisma } from "@/lib/db/client";
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
 */
export async function effectiveCeiling(
  orgId: string,
  projectId?: string | null,
): Promise<ClassificationLevel> {
  const rows = await prisma.dataClassification.findMany({
    where: {
      orgId,
      OR: projectId
        ? [{ projectId: null }, { projectId }]
        : [{ projectId: null }],
    },
    select: { projectId: true, level: true },
  });
  let max: ClassificationLevel = "UNCLASSIFIED";
  for (const r of rows) if (rankOf(r.level) > rankOf(max)) max = r.level;
  return max;
}
