import { z } from "zod";
import { permissionNames, Permission } from "./permissions";

type WorkRoleRow = {
  id: string;
  orgId: string;
  key: string;
  name: string;
  description: string | null;
  grants: string; // decimal string of the permission bitmask (see schema)
  policies: unknown;
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count?: { members: number };
};

/**
 * Serialize a WorkRole for API responses. CRITICAL: `grants` is a BigInt and
 * must never be JSON-serialized raw (throws) — expose it as the array of
 * permission KEYS instead.
 */
export function toWorkRoleDto(r: WorkRoleRow) {
  return {
    id: r.id,
    orgId: r.orgId,
    key: r.key,
    name: r.name,
    description: r.description,
    grants: permissionNames(BigInt(r.grants)),
    policies: Array.isArray(r.policies) ? r.policies : [],
    isBuiltIn: r.isBuiltIn,
    memberCount: r._count?.members ?? 0,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const PERMISSION_KEYS = Object.keys(Permission) as [string, ...string[]];

// Operators are split by the SHAPE of `value` they require: set-membership ops
// take an array, the rest take a scalar. Binding value-type to op at authoring
// time is load-bearing — the engine's compare() returns false for a
// type-mismatched operand (e.g. `in` with a scalar), which for a DENY rule
// reads as "condition definitively false" → the deny silently NO-OPS
// (fail-OPEN). Keeping the two operand classes apart prevents authoring such an
// inert deny. (The engine also fails these closed as defense-in-depth.)
const SCALAR_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "contains"] as const;
const ARRAY_OPERATORS = ["in", "nin"] as const;

// Only relationships with backing data are AUTHORABLE. `owns_resource` is
// computed purely from the resource attributes; `in_project` is resolved by
// requireAccess(). The engine's other relationships (is_manager_of_assignee,
// same_department) have no backing columns yet — a deny over them would just
// fail closed for everyone, confusingly — so reject them at authoring time.
const AUTHORABLE_RELATIONSHIPS = ["owns_resource", "in_project"] as const;

const attrField = z.string().min(1).max(100);

const policyConditionSchema = z.union([
  // scalar-operand condition
  z.object({
    attr: attrField,
    op: z.enum(SCALAR_OPERATORS),
    value: z.union([z.string().max(200), z.number(), z.boolean()]),
  }),
  // set-membership condition — value MUST be a non-empty array
  z.object({
    attr: attrField,
    op: z.enum(ARRAY_OPERATORS),
    value: z.array(z.union([z.string().max(200), z.number()])).min(1).max(50),
  }),
  z.object({ rel: z.enum(AUTHORABLE_RELATIONSHIPS) }),
]);

/**
 * A work-role ABAC policy. v1 is DENY-only (rules NARROW the bitfield; they can
 * never widen it). An `allow` rule is INERT in the engine, so we reject it at
 * authoring time rather than let an admin author a no-op. `actions` must be real
 * permission keys; an empty `conditions` array is an UNCONDITIONAL deny of those
 * actions for anyone holding the role.
 */
export const workRolePolicySchema = z.object({
  id: z.string().max(60).optional(),
  effect: z.literal("deny"),
  actions: z.array(z.enum(PERMISSION_KEYS)).min(1).max(PERMISSION_KEYS.length),
  conditions: z.array(policyConditionSchema).max(10),
});

export const workRolePoliciesSchema = z.array(workRolePolicySchema).max(50);

export const workRoleCreateSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits, underscores"),
  name: z.string().min(1).max(80),
  description: z.string().max(400).nullish(),
  // Permission KEYS the role grants. Unknown keys are rejected by the enum.
  grants: z.array(z.enum(PERMISSION_KEYS)).default([]),
  // Deny policies that NARROW the role's access (see workRolePolicySchema).
  policies: workRolePoliciesSchema.default([]),
});

export const workRoleUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(400).nullish(),
  grants: z.array(z.enum(PERMISSION_KEYS)).optional(),
  policies: workRolePoliciesSchema.optional(),
});
