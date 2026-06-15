/**
 * Shared classification level metadata — labels, colors, ordering. Kept FREE of
 * any `@prisma/client` runtime import so it's safe to use from client AND server
 * components (the settings manager is a client component; the banner is a server
 * one). The string union mirrors the Prisma `ClassificationLevel` enum.
 */

export type ClassificationLevel =
  | "PUBLIC"
  | "UNCLASSIFIED"
  | "FOUO"
  | "CUI"
  | "CONFIDENTIAL";

export const CLASSIFICATION_LEVELS: { value: ClassificationLevel; label: string }[] = [
  { value: "PUBLIC", label: "Public" },
  { value: "UNCLASSIFIED", label: "Unclassified" },
  // FOUO was RETIRED in favor of CUI (DoDI 5200.48). Kept only for legacy data —
  // it renders AS "CUI" and is excluded from the picker (SELECTABLE_… below).
  { value: "FOUO", label: "CUI" },
  { value: "CUI", label: "CUI" },
  { value: "CONFIDENTIAL", label: "Confidential" },
];

/** Levels a user may ASSIGN. Excludes the deprecated FOUO (CUI replaces it). */
export const SELECTABLE_CLASSIFICATION_LEVELS = CLASSIFICATION_LEVELS.filter(
  (l) => l.value !== "FOUO",
);

// Colors follow the standard ISOO/CAPCO classification color scheme:
//   UNCLASSIFIED = green · CUI = purple · CONFIDENTIAL = blue
//   (SECRET = red, TOP SECRET = orange — reserved; this tool's ceiling is
//   CONFIDENTIAL, so no red/orange here). FOUO mirrors CUI (purple).

/** Subdued badge colors (settings table / chips). */
export const CLASSIFICATION_BADGE_COLORS: Record<ClassificationLevel, string> = {
  PUBLIC: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  UNCLASSIFIED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  FOUO: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  CUI: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  CONFIDENTIAL: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
};

/** Strong, high-contrast strip colors for the marking banner. */
export const CLASSIFICATION_BANNER_STYLES: Record<ClassificationLevel, string> = {
  PUBLIC: "bg-emerald-700 text-white",
  UNCLASSIFIED: "bg-emerald-700 text-white",
  FOUO: "bg-violet-700 text-white",
  CUI: "bg-violet-700 text-white",
  CONFIDENTIAL: "bg-blue-700 text-white",
};

/** Low → high sensitivity ordering (also the org-ceiling comparison key). */
export const CLASSIFICATION_RANK: Record<ClassificationLevel, number> = {
  PUBLIC: 0,
  UNCLASSIFIED: 1,
  FOUO: 2,
  CUI: 3,
  CONFIDENTIAL: 4,
};

export function classificationLabel(level: ClassificationLevel): string {
  return CLASSIFICATION_LEVELS.find((l) => l.value === level)?.label ?? level;
}

/**
 * Whether a level warrants a visible marking banner. PUBLIC / UNCLASSIFIED don't
 * need one; FOUO and above do (CUI, controlled, etc.). Keeps the banner from
 * cluttering every ordinary project while guaranteeing controlled work is marked.
 */
export function isMarkingLevel(level: ClassificationLevel): boolean {
  return CLASSIFICATION_RANK[level] >= CLASSIFICATION_RANK.FOUO;
}
