/**
 * The filter every time-entry query needs, and the reason it is a shared
 * constant rather than four characters typed inline.
 *
 * 2.251.0 made deletion a VOID: the row survives with `voidedAt` set, and reads
 * filter it out. Two read routes were updated. Roughly twenty other queries
 * were not — and the omission was not merely cosmetic, because it reopened a
 * path that silently UNDOES a void:
 *
 *   1. void a DRAFT entry     -> voidedAt set, status stays DRAFT
 *   2. POST .../submit        -> looked up by (id, orgId) only; still DRAFT,
 *                                so it becomes SUBMITTED
 *   3. bulk-approve           -> SUBMITTED, so it becomes APPROVED
 *   4. lib/pm/burn.ts         -> counts `status: APPROVED` toward the CLIN's
 *                                consumed funded value
 *
 * A deleted entry's hours end up billed against a contract. Exports and the AI
 * time/finance executors had the milder version of the same problem: they carry
 * no status filter at all, so they returned voided drafts immediately.
 *
 * Prisma has no global model filter, so correctness here depends on every call
 * site remembering — which is exactly the kind of rule that decays. Hence the
 * named constant plus `not-voided.arch.test.ts`, which fails the build when a
 * new query forgets it.
 */
export const NOT_VOIDED = { voidedAt: null } as const;

/**
 * Merge `NOT_VOIDED` into an existing where-clause.
 *
 * Use when the clause is built dynamically; spread `...NOT_VOIDED` directly
 * when it is a literal. Both are greppable, which is what the arch test keys on.
 */
export function excludeVoided<T extends Record<string, unknown>>(
  where: T,
): T & { voidedAt: null } {
  return { ...where, ...NOT_VOIDED };
}
