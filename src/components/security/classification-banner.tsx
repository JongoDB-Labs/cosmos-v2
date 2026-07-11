import { prisma } from "@/lib/db/client";
import { cn } from "@/lib/utils";
import {
  CLASSIFICATION_BANNER_STYLES,
  classificationLabel,
  isMarkingLevel,
  type ClassificationLevel,
} from "@/lib/classification/levels";

/**
 * Server-rendered data-classification marking strip for a project. Resolves the
 * EFFECTIVE classification — the project's own row if set, else the org-wide row
 * (projectId: null) — and renders a colored banner with the level + any markings
 * when the level warrants one (FOUO and above). Renders nothing for
 * PUBLIC/UNCLASSIFIED or when no classification is set.
 *
 * This is the marking surface v2 was missing. Pure read of DataClassification
 * (no cookies/headers), so it's safe to render directly in the project layout.
 */
export async function ClassificationBanner({
  orgId,
  projectId,
}: {
  orgId: string;
  projectId: string;
}) {
  const [projectRow, orgRow] = await Promise.all([
    prisma.dataClassification.findUnique({
      where: { orgId_projectId: { orgId, projectId } },
      select: { level: true, markings: true },
    }),
    // Org-wide fallback. findFirst (not findUnique) because a compound unique
    // with a NULL member isn't addressable via findUnique in Prisma.
    prisma.dataClassification.findFirst({
      where: { orgId, projectId: null },
      select: { level: true, markings: true },
    }),
  ]);

  const effective = projectRow ?? orgRow;
  if (!effective) return null;

  const level = effective.level as ClassificationLevel;
  if (!isMarkingLevel(level)) return null;

  // Real DoD/CUI banner lines join the classification and its dissemination
  // controls with "//" and NO surrounding spaces (DoDM 5200.01, Vol. 2), e.g.
  // "CUI//NOFORN" or "CONFIDENTIAL//NOFORN" — not "CUI // NOFORN".
  const label = classificationLabel(level).toUpperCase();
  const controls =
    effective.markings.length > 0 ? `//${effective.markings.join("//")}` : "";

  return (
    <div
      role="note"
      aria-label={`Data classification: ${label}${controls}`}
      className={cn(
        "flex items-center justify-center px-4 py-1 text-center text-xs font-semibold tracking-wide",
        CLASSIFICATION_BANNER_STYLES[level],
      )}
    >
      <span>
        {label}
        {controls && <span className="font-normal opacity-90">{controls}</span>}
      </span>
    </div>
  );
}
