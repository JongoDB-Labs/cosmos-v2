import type { ClassificationLevel, TenantClass } from "@prisma/client";
import { ForbiddenError } from "@/lib/rbac/check";

/**
 * Classification markings are a GOV-tenant concern.
 *
 * WHAT WAS WRONG. Four PM register models (Risk, Deliverable, Blocker,
 * ChangeRequest) carried `classification ClassificationLevel @default(CUI)`,
 * and no application code ever wrote the column. Every row of every tenant was
 * therefore silently stamped Controlled Unclassified Information — including
 * commercial firms, which hold no CUI authority and for whom the marking is not
 * merely noise but wrong. A marking nobody chose is worse than no marking: it
 * looks deliberate on screen and in exports.
 *
 * THE RULE. Classification exists only for a GOV tenant. For a COMMERCIAL
 * tenant the column is NULL and the field is not surfaced at all — not shown
 * empty, not shown as "Unclassified", simply absent. `null` means "not
 * applicable to this tenant", never "not yet decided".
 *
 * WHY OMIT RATHER THAN STRIP. `classificationOmit` feeds Prisma's `omit`, so
 * the column is never read for a tenant that has no business with it. This
 * mirrors the money discipline elsewhere in the codebase: a gated field is
 * never CONSTRUCTED for an ineligible viewer, rather than being built and then
 * removed on the way out. Strip-after leaks the moment someone adds a new
 * response path and forgets the strip; never-select cannot.
 */

/** True when the tenant may carry classification markings at all. */
export function classificationApplies(tenantClass: TenantClass): boolean {
  return tenantClass === "GOV";
}

/**
 * Prisma `omit` clause hiding `classification` from non-GOV tenants.
 * Returns undefined for GOV, which Prisma treats as "omit nothing".
 */
export function classificationOmit(
  tenantClass: TenantClass,
): { classification: true } | undefined {
  return classificationApplies(tenantClass) ? undefined : { classification: true };
}

/**
 * Reject an attempt to SET a classification on a tenant that has none.
 *
 * Clearing (null/undefined) is always allowed — a commercial tenant must be
 * able to null out a marking inherited from the old default without being told
 * it is forbidden to do so.
 */
export function assertClassificationAllowed(
  tenantClass: TenantClass,
  value: ClassificationLevel | null | undefined,
): void {
  if (value === null || value === undefined) return;
  if (!classificationApplies(tenantClass)) {
    throw new ForbiddenError(
      "Classification markings are available to GOV tenants only.",
    );
  }
}
