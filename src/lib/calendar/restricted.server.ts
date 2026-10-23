import { prisma } from "@/lib/db/client";
import { isMarkingLevel } from "@/lib/classification/levels";
import { rankOf } from "@/lib/classification/effective";
import { detectMarkings } from "@/lib/classification/markings";
import type { ClassificationLevel } from "@prisma/client";

/**
 * Is this record RESTRICTED for anything that leaves Cosmos (calendar sync,
 * COSMOS-202 B2)? Yes when its project's (or the org's) classification ceiling
 * carries a marking, or its own text does. Restricted things go out as a
 * plain busy block: no title, no body, no link.
 */
export async function isRestricted(
  orgId: string,
  projectId: string | null,
  ...text: (string | null | undefined)[]
): Promise<boolean> {
  if (text.some((t) => !!t && detectMarkings(t))) return true;
  const rows = await prisma.dataClassification.findMany({
    where: { orgId, OR: projectId ? [{ projectId: null }, { projectId }] : [{ projectId: null }] },
    select: { level: true },
  });
  let max: ClassificationLevel = "UNCLASSIFIED";
  for (const r of rows) if (rankOf(r.level) > rankOf(max)) max = r.level;
  return isMarkingLevel(max);
}

/** What a restricted record is called outside Cosmos. */
export const RESTRICTED_TITLE = "Cosmos item";
