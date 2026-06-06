/**
 * Work-role ABAC engine — the PURE decision function (no DB, no async, no I/O),
 * so it is exhaustively unit-testable (see engine.test.ts).
 *
 * Security model (v1), deliberately conservative:
 *   - Work-role GRANTS (a BigInt permission mask) WIDEN the actor's bitfield;
 *     folded into `effectivePermissions` upstream (loadEffectivePermissions).
 *   - ABAC rules can only NARROW, and v1 supports DENY rules only: the decision
 *     is `RBAC-baseline AND NOT(any firing deny)`. An `allow` rule is INERT in
 *     v1 (reserved for a future conditional-grant iteration) — this removes the
 *     "authoring an allow silently revokes the baseline" footgun entirely.
 *
 * Critical invariants (each maps to a reviewed risk + a test):
 *   - OWNER break-glass is the FIRST check. (R-5)
 *   - No escalation: bitfield must already grant the action, checked BEFORE any
 *     rule; an unknown action fails closed. (R-2/R-10)
 *   - Fall-through: no deny references the action → exact bitfield result. (R-2)
 *   - A rule with empty `actions` references NOTHING. (R-3)
 *   - DENY fails CLOSED: a deny fires unless some condition is DEFINITIVELY
 *     false. A condition over a missing attribute / unresolved relationship is
 *     "unresolvable" → the deny still fires (never silently bypassed). This is
 *     the fix for the fail-open-deny defect.
 *   - Numeric comparisons coerce numeric strings so a deny can't silently no-op.
 *   - Attribute paths are own-property-only; __proto__/constructor/prototype
 *     segments and non-string paths are rejected. (R-6)
 *   - Malformed conditions are filtered at coerce time (no crash on bad JSON).
 */
import { Permission, hasPermission, type PermissionKey } from "@/lib/rbac/permissions";

export type AbacEffect = "allow" | "deny";

export type AbacOperator =
  | "eq"
  | "ne"
  | "in"
  | "nin"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains";

const KNOWN_OPERATORS = new Set<string>([
  "eq",
  "ne",
  "in",
  "nin",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
]);

/** DB-backed relationship predicates. `owns_resource` is computed purely from
 *  the resource attributes + actorUserId; the others must be pre-resolved by
 *  the async caller and passed in `relationships` (else "unresolvable"). */
export type AbacRelationship =
  | "owns_resource"
  | "in_project"
  | "is_manager_of_assignee"
  | "same_department";

const KNOWN_RELATIONSHIPS = new Set<string>([
  "owns_resource",
  "in_project",
  "is_manager_of_assignee",
  "same_department",
]);

export type AbacCondition =
  | {
      attr: string;
      op: AbacOperator;
      value: string | number | boolean | Array<string | number>;
    }
  | { rel: AbacRelationship };

export interface AbacRule {
  id?: string;
  effect: AbacEffect;
  /** Actions this rule governs. REQUIRED + non-empty to "reference" an action. */
  actions: PermissionKey[];
  /** ALL must hold for the rule to fire (logical AND). Empty = unconditional. */
  conditions: AbacCondition[];
}

export interface ResourceAttributes {
  /** Owner-ish fields MUST be User.ids (owns_resource compares to actorUserId). */
  ownerId?: string | null;
  createdById?: string | null;
  assigneeId?: string | null;
  projectId?: string | null;
  orgId?: string | null;
  [key: string]: unknown;
}

export interface EvaluateAccessArgs {
  /** Effective bitfield = role base | stored override | work-role grants. */
  effectivePermissions: bigint;
  action: PermissionKey;
  /** True when the actor is the org OWNER (full break-glass). */
  isOwner?: boolean;
  /** Acting User.id — used to compute owns_resource purely. */
  actorUserId?: string;
  resource?: ResourceAttributes;
  /** Pre-resolved DB-backed relationship predicates (absent = unresolvable). */
  relationships?: Partial<Record<AbacRelationship, boolean>>;
  /** Collected (and coerced) rules from OrgMember.abacRules + WorkRole.policies. */
  rules: AbacRule[];
}

/** A condition is true, definitively false, or unresolvable (data absent). */
type CondResult = "true" | "false" | "unresolvable";

const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/** Own-property-only deep get; refuses prototype-pollution + non-string paths. (R-6) */
function safeGet(obj: unknown, path: string): unknown {
  if (typeof path !== "string" || path.length === 0) return undefined;
  if (obj == null) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (FORBIDDEN_PATH_SEGMENTS.has(seg)) return undefined;
    if (cur == null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Compare two PRESENT values. Numeric comparators coerce numeric strings so a
 *  deny can't silently no-op on `"5000"` vs `5000`. Returns false (not throw)
 *  on genuinely incomparable operands. */
function compare(actual: unknown, op: AbacOperator, expected: unknown): boolean {
  switch (op) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual as never);
    case "nin":
      return Array.isArray(expected) && !expected.includes(actual as never);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = typeof actual === "number" ? actual : Number(actual);
      const b = typeof expected === "number" ? expected : Number(expected);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
    }
    case "contains":
      if (typeof actual === "string") return actual.includes(String(expected));
      if (Array.isArray(actual)) return actual.includes(expected as never);
      return false;
    default:
      return false;
  }
}

function resolveRelationship(
  rel: AbacRelationship,
  args: EvaluateAccessArgs,
): CondResult {
  if (rel === "owns_resource") {
    const a = args.actorUserId;
    const r = args.resource;
    // Can't determine ownership without the actor + at least one owner field.
    if (!a || !r) return "unresolvable";
    if (r.ownerId == null && r.createdById == null && r.assigneeId == null) {
      return "unresolvable";
    }
    return r.ownerId === a || r.createdById === a || r.assigneeId === a
      ? "true"
      : "false";
  }
  const resolved = args.relationships?.[rel];
  if (resolved === undefined) return "unresolvable"; // not pre-resolved
  return resolved ? "true" : "false";
}

function evalCondition(cond: AbacCondition, args: EvaluateAccessArgs): CondResult {
  if ("rel" in cond) return resolveRelationship(cond.rel, args);
  const actual = safeGet(args.resource, cond.attr);
  if (actual === undefined) return "unresolvable"; // attribute absent
  // Operand/operator type mismatch (a set op `in`/`nin` without an array, or a
  // scalar op WITH an array) is malformed: compare() would return false, which
  // for a DENY reads as "definitively false" and silently suppresses the deny
  // (fail-OPEN). Treat it as UNRESOLVABLE so the deny fails CLOSED, consistent
  // with a missing attribute. (Authoring-time validation rejects these too.)
  const isSetOp = cond.op === "in" || cond.op === "nin";
  if (isSetOp !== Array.isArray(cond.value)) return "unresolvable";
  return compare(actual, cond.op, cond.value) ? "true" : "false";
}

/** A DENY fires unless some condition is DEFINITIVELY false — an unresolvable
 *  condition (missing attr / unresolved relationship) keeps the deny firing
 *  (fail-closed). Empty conditions = unconditional fire. */
function denyFires(rule: AbacRule, args: EvaluateAccessArgs): boolean {
  return rule.conditions.every((c) => evalCondition(c, args) !== "false");
}

function references(rule: AbacRule, action: PermissionKey): boolean {
  // Empty/missing actions reference NOTHING (never "all"). (R-3)
  return Array.isArray(rule.actions) && rule.actions.includes(action);
}

/**
 * The pure access decision: true iff the actor may perform `action` on the
 * (optional) resource. Narrowing-only — never grants beyond the bitfield.
 */
export function evaluateAccess(args: EvaluateAccessArgs): boolean {
  // 1. OWNER break-glass — FIRST, unconditional. (R-5)
  if (args.isOwner) return true;

  // 2. No escalation: an unknown action or a missing bit fails closed BEFORE
  //    any rule is consulted. (R-2/R-10)
  const bit = Permission[args.action];
  if (bit === undefined) return false;
  if (!hasPermission(args.effectivePermissions, bit)) return false;

  // 3. v1: only DENY rules referencing this action narrow access.
  const denies = (args.rules ?? []).filter(
    (r) => r.effect === "deny" && references(r, args.action),
  );

  // 4. Fall-through: no deny references the action → exact bitfield result. (R-2)
  if (denies.length === 0) return true;

  // 5. Any firing deny (deny-precedence, fail-closed on unresolvable) → denied.
  return !denies.some((r) => denyFires(r, args));
}

/** Coerce a stored value (OrgMember.abacRules object or WorkRole.policies
 *  array) into clean, well-formed AbacRule[]. Tolerates the `{}` default and a
 *  `{ rules: [...] }` wrapper; drops malformed rules/conditions so the pure
 *  engine never sees bad JSON. (R-7 + crash-hardening) */
export function coerceRules(raw: unknown): AbacRule[] {
  if (Array.isArray(raw)) return raw.filter(isAbacRule);
  if (raw && typeof raw === "object" && Array.isArray((raw as { rules?: unknown }).rules)) {
    return (raw as { rules: unknown[] }).rules.filter(isAbacRule);
  }
  return [];
}

function isValidCondition(c: unknown): c is AbacCondition {
  if (!c || typeof c !== "object") return false;
  if ("rel" in c) return KNOWN_RELATIONSHIPS.has((c as { rel: unknown }).rel as string);
  const attr = (c as { attr?: unknown }).attr;
  const op = (c as { op?: unknown }).op;
  return (
    typeof attr === "string" &&
    attr.length > 0 &&
    typeof op === "string" &&
    KNOWN_OPERATORS.has(op)
  );
}

function isAbacRule(v: unknown): v is AbacRule {
  if (!v || typeof v !== "object") return false;
  const r = v as AbacRule;
  return (
    (r.effect === "allow" || r.effect === "deny") &&
    Array.isArray(r.actions) &&
    r.actions.every((a) => typeof a === "string") &&
    Array.isArray(r.conditions) &&
    r.conditions.every(isValidCondition)
  );
}
