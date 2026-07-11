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

/**
 * Canonical U.S. classification banner-color standard — the single reference the
 * badge/banner palettes below are derived from and MUST NOT drift from.
 *
 * Authoritative sources:
 *   • Standard-Form classified cover sheets, prescribed by ISOO (32 CFR 2001):
 *       SF 703 TOP SECRET = orange · SF 704 SECRET = red · SF 705 CONFIDENTIAL = blue.
 *   • Controlled Unclassified Information (CUI) — DoDI 5200.48 & 32 CFR Part 2002
 *     (ISOO CUI Program): CUI = purple. This program RETIRED the FOUO marking.
 *   • DoD/IC information-system banner convention: UNCLASSIFIED = green,
 *     TOP SECRET//SCI = yellow.
 *   • Banner/portion-mark FORMAT ("//" separators): DoDM 5200.01, Vol. 2
 *     ("DoD Information Security Program: Marking of Information").
 *
 * RED IS RESERVED FOR SECRET. This tool's assignable ceiling is CONFIDENTIAL, so
 * SECRET (red), TOP SECRET (orange) and TS//SCI (yellow) appear here as documented
 * reference ONLY — they are deliberately NOT selectable levels (making them so would
 * require the egress rank tables + the Prisma enum to grow in lockstep). A
 * CONFIDENTIAL banner is therefore BLUE, never red; FOUO mirrors CUI (purple).
 */
export const CLASSIFICATION_COLOR_STANDARD = {
  UNCLASSIFIED: { color: "green", source: "DoD/IC banner convention" },
  CUI: { color: "purple", source: "DoDI 5200.48 · 32 CFR 2002 (ISOO CUI Program)" },
  CONFIDENTIAL: { color: "blue", source: "SF 705 (ISOO, 32 CFR 2001)" },
  // Reference only — above this tool's CONFIDENTIAL ceiling, hence not selectable.
  SECRET: { color: "red", source: "SF 704 (ISOO, 32 CFR 2001)" },
  TOP_SECRET: { color: "orange", source: "SF 703 (ISOO, 32 CFR 2001)" },
  "TOP_SECRET//SCI": { color: "yellow", source: "DoD/IC banner convention" },
} as const;

/**
 * Subdued badge colors (settings table / chips). Palette per level matches
 * CLASSIFICATION_COLOR_STANDARD: green=UNCLASS, purple=CUI/FOUO, blue=CONFIDENTIAL.
 */
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
