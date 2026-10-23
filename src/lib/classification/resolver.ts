// src/lib/classification/resolver.ts
//
// Per-row classification for anything that renders MANY rows across projects
// (calendar feed, Issues export, dashboard panels). Loads the org's
// DataClassification rows once, then answers per project without another query.
//
// The rule is the calendar feed's, which it was extracted from: a row is
// RESTRICTED when its project's effective ceiling (max of the org row and the
// project row, `effectiveCeiling`) is a marking level, or when its own text
// carries a marking (`detectMarkings`, the "detector, not declassifier" tripwire).
import { prisma } from "@/lib/db/client";
import type { ClassificationLevel } from "@prisma/client";
import { rankOf } from "./effective";
import { isMarkingLevel } from "./levels";
import { detectMarkings } from "./markings";

export interface ClassificationResolver {
  /** The org ceiling alone (UNCLASSIFIED when no org row is set). */
  readonly orgLevel: ClassificationLevel;
  /** Effective ceiling for a project: max(org row, project row). */
  levelFor(projectId: string | null): ClassificationLevel;
  /** True when the project's ceiling is a marking level or any text is marked. */
  restricted(projectId: string | null, ...text: (string | null | undefined)[]): boolean;
  /**
   * The level a row should be handled at: its project ceiling, raised to CUI
   * when its own text carries a marking. Only ever raises.
   */
  rowLevel(projectId: string | null, ...text: (string | null | undefined)[]): ClassificationLevel;
}

/** Pure core, so callers' tests can build one from fixture rows. */
export function classificationResolverFromRows(
  rows: { projectId: string | null; level: ClassificationLevel }[],
): ClassificationResolver {
  const orgLevel: ClassificationLevel = rows.find((c) => c.projectId === null)?.level ?? "UNCLASSIFIED";
  const byProject = new Map<string, ClassificationLevel>();
  for (const r of rows) if (r.projectId) byProject.set(r.projectId, r.level);
  const levelFor = (pid: string | null): ClassificationLevel => {
    const p = pid ? byProject.get(pid) : undefined;
    return p && rankOf(p) > rankOf(orgLevel) ? p : orgLevel;
  };
  const marked = (text: (string | null | undefined)[]) => text.some((t) => !!t && detectMarkings(t));
  return {
    orgLevel,
    levelFor,
    restricted: (pid, ...text) => isMarkingLevel(levelFor(pid)) || marked(text),
    rowLevel: (pid, ...text) => {
      const level = levelFor(pid);
      return marked(text) && rankOf(level) < rankOf("CUI") ? "CUI" : level;
    },
  };
}

export async function createClassificationResolver(orgId: string): Promise<ClassificationResolver> {
  const rows = await prisma.dataClassification.findMany({
    where: { orgId },
    select: { projectId: true, level: true },
  });
  return classificationResolverFromRows(rows);
}
