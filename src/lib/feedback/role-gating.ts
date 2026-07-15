/**
 * Role-based auto-trigger gating (COSMOS-120, Phase 3b).
 *
 * Not every submitter should be able to auto-trigger an autonomous build from
 * their feedback. A lower-trust role — a GUEST or a read-only VIEWER — may be an
 * external stakeholder, a trial user, or an anonymous-ish account; their requests
 * should land in front of a HUMAN for triage first rather than flowing straight
 * into the build backlog. Ordinary members and above stay on the normal
 * auto-triage path. This is the deterministic, PURE decision layer that answers
 * "may THIS submitter's role auto-trigger a build?" — no DB, no imports, so it is
 * exhaustively unit-testable and the gate holds even when the model / AI egress
 * is down (same reason the intake guardrails and rate-limits are pure).
 *
 * Enforced + configurable per org: the set of roles cleared to auto-trigger lives
 * in `Organization.settings.autoTriggerRoles`. Absent / malformed → the safe
 * default (members and above; VIEWER + GUEST route to human triage). An org can
 * widen or tighten the set, but the shape is always validated against the real
 * `OrgRole` enum so an untrusted settings blob can never smuggle in a bogus role.
 */

import type { OrgRole } from "@prisma/client";

/** Every org role, ordered most-trusted → least-trusted. The canonical list the
 *  config validates against and the gate's ordering reference. */
export const ORG_ROLES: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "BILLING_ADMIN",
  "MEMBER",
  "VIEWER",
  "GUEST",
] as const;

/**
 * Roles cleared to auto-trigger an autonomous build by DEFAULT — members and
 * above. VIEWER and GUEST are deliberately excluded: their feedback routes to a
 * human triage step first. An org can override this via settings, but this is the
 * safe fallback for any org that never touches the setting.
 */
export const DEFAULT_AUTO_TRIGGER_ROLES: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "BILLING_ADMIN",
  "MEMBER",
] as const;

export interface RoleGateConfig {
  /** The set of org roles whose feedback may auto-trigger a build. Any role NOT
   *  in this set (and any submitter with no resolvable membership) routes to
   *  human triage instead. Normalized: valid `OrgRole`s only, de-duplicated,
   *  in `ORG_ROLES` order — so it round-trips through read → write → read. */
  autoTriggerRoles: OrgRole[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROLE_SET = new Set<string>(ORG_ROLES);

function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && ROLE_SET.has(value);
}

/** Coerce an untrusted list into a validated, de-duplicated, canonically-ordered
 *  set of OrgRoles. Non-array / all-invalid input yields null so the caller can
 *  fall back to the default. */
function toRoleList(value: unknown): OrgRole[] | null {
  if (!Array.isArray(value)) return null;
  const valid = value.filter(isOrgRole);
  if (valid.length === 0) return null;
  const seen = new Set<OrgRole>(valid);
  return ORG_ROLES.filter((r) => seen.has(r));
}

/**
 * Normalize an org's `settings.autoTriggerRoles` (untrusted, unknown shape) into a
 * validated RoleGateConfig. Absent / malformed / all-invalid → the safe default
 * (members and above). Pure and idempotent: feeding a normalized config's own
 * `autoTriggerRoles` back in yields the same config (config round-trip).
 */
export function readRoleGateConfig(settings: unknown): RoleGateConfig {
  const root = isRecord(settings) ? settings : {};
  const roles = toRoleList(root.autoTriggerRoles);
  return { autoTriggerRoles: roles ?? [...DEFAULT_AUTO_TRIGGER_ROLES] };
}

/**
 * The gate. `role` is the submitter's org role, or null when no membership could
 * be resolved (e.g. the account left the org after filing). A null / unknown role
 * is treated as LOWEST trust — it never auto-triggers; it routes to human triage.
 */
export function canRoleAutoTrigger(role: OrgRole | null | undefined, config: RoleGateConfig): boolean {
  if (!isOrgRole(role)) return false;
  return config.autoTriggerRoles.includes(role);
}

/** A short, submitter-facing explanation for why their request went to a human
 *  first rather than being picked up automatically. No internal role names. */
export function roleGateMessage(): string {
  return "a teammate will review it before any automated work begins";
}
