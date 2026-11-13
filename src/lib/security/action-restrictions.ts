import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AbacCondition, AbacRule } from "@/lib/abac/engine";

/**
 * Validates an org's action restrictions (security settings) before they are
 * stored. The engine reads stored rules leniently and drops what it can't use
 * (coerceRules), so a typo stored here would quietly restrict nothing. Every
 * rule is therefore checked strictly, and the first problem is reported with
 * the index of the rule it is in.
 *
 * A rule is a DENY of one or more actions (permission keys), with optional
 * conditions that ALL must hold for it to apply:
 *   - { rel: "owns_resource" }  the person owns, created or is assigned it;
 *   - { rel: "in_project" }     the person is a member of its project;
 *   - { attr, op, value }       a field of the resource, one of RESTRICTION_ATTRS.
 * With no conditions it applies everywhere, and removes the permission itself
 * (effective-permissions.ts); with conditions it applies where an access check
 * names the resource.
 */

/** Resource fields an access check passes, and so a condition can test. */
export const RESTRICTION_ATTRS = ["projectId", "ownerId", "createdById", "assigneeId", "objectiveId"] as const;
const ATTRS = new Set<string>(RESTRICTION_ATTRS);
const RELATIONSHIPS = new Set(["owns_resource", "in_project"]);
const SCALAR_OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "contains"]);
const SET_OPS = new Set(["in", "nin"]);
export const MAX_RESTRICTIONS = 50;
const MAX_CONDITIONS = 10;

export type RestrictionsResult =
  | { ok: true; rules: AbacRule[] }
  | { ok: false; ruleIndex: number | null; error: string };

const isScalar = (v: unknown) =>
  (typeof v === "string" && v.length <= 200) || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean";

function conditionProblem(c: unknown): string | null {
  if (!c || typeof c !== "object" || Array.isArray(c)) return "a condition must be an object";
  const keys = Object.keys(c);
  if ("rel" in c) {
    const rel = (c as { rel: unknown }).rel;
    if (keys.length !== 1) return "a relationship condition takes only rel";
    if (typeof rel !== "string" || !RELATIONSHIPS.has(rel)) return `unknown relationship ${JSON.stringify(rel)}`;
    return null;
  }
  const { attr, op, value } = c as { attr?: unknown; op?: unknown; value?: unknown };
  if (keys.some((k) => k !== "attr" && k !== "op" && k !== "value")) return "a condition takes only attr, op and value";
  if (typeof attr !== "string" || !ATTRS.has(attr)) return `unknown attribute ${JSON.stringify(attr)}`;
  if (typeof op !== "string" || (!SCALAR_OPS.has(op) && !SET_OPS.has(op))) return `unknown operator ${JSON.stringify(op)}`;
  if (SET_OPS.has(op)) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 50 || !value.every((v) => isScalar(v) && typeof v !== "boolean")) {
      return `${op} needs a list of 1 to 50 values`;
    }
  } else if (!isScalar(value)) return `${op} needs a single value`;
  return null;
}

function ruleProblem(r: unknown): string | null {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "a rule must be an object";
  const rule = r as Record<string, unknown>;
  const extra = Object.keys(rule).filter((k) => !["id", "effect", "actions", "conditions"].includes(k));
  if (extra.length) return `unknown field ${JSON.stringify(extra[0])}`;
  if (rule.id !== undefined && (typeof rule.id !== "string" || rule.id.length > 60)) return "id must be text of at most 60 characters";
  if (rule.effect !== "deny") return "only deny rules are supported";
  if (!Array.isArray(rule.actions) || rule.actions.length === 0) return "actions must list at least one action";
  for (const a of rule.actions) {
    if (typeof a !== "string" || !Object.prototype.hasOwnProperty.call(Permission, a)) return `unknown action ${JSON.stringify(a)}`;
  }
  if (!Array.isArray(rule.conditions)) return "conditions must be a list (empty applies everywhere)";
  if (rule.conditions.length > MAX_CONDITIONS) return `at most ${MAX_CONDITIONS} conditions`;
  for (const c of rule.conditions) {
    const problem = conditionProblem(c);
    if (problem) return problem;
  }
  return null;
}

/** Check a submitted list of restrictions. Nothing is dropped: one bad rule refuses the lot. */
export function parseActionRestrictions(raw: unknown): RestrictionsResult {
  if (!Array.isArray(raw)) return { ok: false, ruleIndex: null, error: "actionRestrictions must be a list of rules" };
  if (raw.length > MAX_RESTRICTIONS) return { ok: false, ruleIndex: null, error: `at most ${MAX_RESTRICTIONS} rules` };
  for (let i = 0; i < raw.length; i++) {
    const problem = ruleProblem(raw[i]);
    if (problem) return { ok: false, ruleIndex: i, error: `Rule ${i + 1}: ${problem}` };
  }
  return {
    ok: true,
    rules: raw.map((r: { id?: string; actions: string[]; conditions: AbacCondition[] }) => ({
      ...(r.id !== undefined ? { id: r.id } : {}),
      effect: "deny" as const,
      actions: [...new Set(r.actions)] as PermissionKey[],
      conditions: r.conditions,
    })),
  };
}
