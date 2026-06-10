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
  { value: "FOUO", label: "FOUO" },
  { value: "CUI", label: "CUI" },
  { value: "CONFIDENTIAL", label: "Confidential" },
];

/** Subdued badge colors (settings table / chips). */
export const CLASSIFICATION_BADGE_COLORS: Record<ClassificationLevel, string> = {
  PUBLIC: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  UNCLASSIFIED: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  FOUO: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  CUI: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  CONFIDENTIAL: "bg-red-500/15 text-red-700 dark:text-red-400",
};

/** Strong, high-contrast strip colors for the marking banner. */
export const CLASSIFICATION_BANNER_STYLES: Record<ClassificationLevel, string> = {
  PUBLIC: "bg-emerald-600 text-white",
  UNCLASSIFIED: "bg-blue-600 text-white",
  FOUO: "bg-amber-600 text-white",
  CUI: "bg-orange-600 text-white",
  CONFIDENTIAL: "bg-red-700 text-white",
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
