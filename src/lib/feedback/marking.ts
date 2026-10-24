/**
 * Classification markings on feedback comments (gov tenants). Client-safe: the
 * composer and the server apply the same rule, so what staff are told before
 * posting is what the server does.
 */
import {
  CLASSIFICATION_RANK,
  SELECTABLE_CLASSIFICATION_LEVELS,
  type ClassificationLevel,
} from "@/lib/classification/levels";

/** The markings staff can put on a comment (FOUO is retired in favour of CUI). */
export const COMMENT_MARKINGS = SELECTABLE_CLASSIFICATION_LEVELS;

/** Legacy FOUO is CUI under another name. */
const rank = (level: ClassificationLevel) =>
  level === "FOUO" ? CLASSIFICATION_RANK.CUI : CLASSIFICATION_RANK[level];

/**
 * A comment marked CUI or above stays internal unless the org's own ceiling
 * already covers that level: then every member handles it anyway.
 */
export function markingForcesInternal(level: ClassificationLevel, orgCeiling: ClassificationLevel): boolean {
  return rank(level) >= CLASSIFICATION_RANK.CUI && rank(level) > rank(orgCeiling);
}
