import type { TenantClass } from "@prisma/client";

/**
 * PROTECTIVENESS ORDERING of the tenant classes that drive the CUI-blind egress gate.
 *
 * A HIGHER rank means MORE protective — i.e. MORE of an org's content is masked before it
 * reaches the AI model:
 *   - GOV        (rank 1) — MOST protective. Fully CUI-blind: tool-result content (project
 *                names, ticket titles, member names, notes, free-text) is masked out.
 *   - COMMERCIAL (rank 0) — LEAST protective. Masking off: the model sees content unmasked.
 *
 * Declared as a Record over the whole enum, so if a new TenantClass is ever added the compiler
 * FORCES it to be ranked here (there is no safe default for "how much does this class mask").
 */
export const TENANT_CLASS_PROTECTIVENESS: Record<TenantClass, number> = {
  GOV: 1,
  COMMERCIAL: 0,
};

/** All tenant classes ordered MOST → LEAST protective (for rendering ordered choices). */
export const TENANT_CLASSES_BY_PROTECTIVENESS: TenantClass[] = (
  Object.keys(TENANT_CLASS_PROTECTIVENESS) as TenantClass[]
).sort((a, b) => TENANT_CLASS_PROTECTIVENESS[b] - TENANT_CLASS_PROTECTIVENESS[a]);

/** Narrow an untrusted value to a known TenantClass. */
export function isValidTenantClass(value: unknown): value is TenantClass {
  return typeof value === "string" && value in TENANT_CLASS_PROTECTIVENESS;
}

/**
 * True when `target` is AT LEAST AS protective as `current` (equal or more masking). This is
 * the TIGHTEN-or-no-op direction: it can only ever INCREASE the CUI-blind masking, so it can
 * never leak CUI to the model. This is the direction a tenant OWNER may take self-service.
 */
export function isAtLeastAsProtective(target: TenantClass, current: TenantClass): boolean {
  return TENANT_CLASS_PROTECTIVENESS[target] >= TENANT_CLASS_PROTECTIVENESS[current];
}

/**
 * True when moving from `current` to `target` REDUCES protection (removes masking). This is
 * the platform-owner-only direction — a tenant OWNER must NOT be able to do it self-service
 * (it would let a gov tenant disable its own CUI protection). Inverse of isAtLeastAsProtective.
 */
export function isLoosening(target: TenantClass, current: TenantClass): boolean {
  return !isAtLeastAsProtective(target, current);
}
