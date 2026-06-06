// src/lib/classification/effective.ts
import { prisma } from "@/lib/db/client";
import type { ClassificationLevel } from "@prisma/client";

const ORDER: ClassificationLevel[] = ["PUBLIC", "UNCLASSIFIED", "FOUO", "CUI", "CONFIDENTIAL"];

export function rankOf(level: ClassificationLevel): number {
  return ORDER.indexOf(level);
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
