import { z } from "zod";

// Canonical CRM pipeline stage keys. These MUST stay in sync with the column
// keys the pipeline board renders (src/components/crm/pipeline-board.tsx): a
// contact is placed in a column by an exact `stage` match, so any contact whose
// stage is not one of these is invisible on the board — it only shows up in the
// aggregate header stats. Validate writes through crmStageSchema and filters
// through canonicalizeStageFilter so casing can never orphan a contact.
export const CRM_STAGE_KEYS = [
  "LEAD",
  "QUALIFIED",
  "PROPOSAL",
  "NEGOTIATION",
  "CLOSED_WON",
  "CLOSED_LOST",
] as const;

export type CrmStageKey = (typeof CRM_STAGE_KEYS)[number];

export const DEFAULT_CRM_STAGE: CrmStageKey = "LEAD";

/**
 * Zod field for a contact's stage on WRITE (create/update). Case-insensitive
 * ("lead" → "LEAD") but REJECTS unknown values with a validation error instead
 * of silently coercing them — coercing a typo to the default would silently
 * demote an existing contact (e.g. NEGOTIATION → LEAD) on a 200 OK. `null`/
 * `undefined` are allowed so callers can omit the field; the route decides
 * whether to default (create) or leave it untouched (update).
 */
export const crmStageSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
  z.enum(CRM_STAGE_KEYS).nullish(),
);

/** Case-normalize a stage for *filtering* (no default, no rejection — unknown
 * stays as-is so a query for a nonexistent stage returns nothing rather than
 * LEAD results). Used by the contacts GET route and the AI query_crm tool. */
export function canonicalizeStageFilter(input: string): string {
  return input.trim().toUpperCase();
}
