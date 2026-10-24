/**
 * A workflow definition: the statuses a (project × work-item type) uses and
 * the transitions between them, with what each transition restricts, asks
 * for, validates and does.
 *
 * Declarative JSON, validated here and stored in immutable `WorkflowVersion`
 * rows. No code runs from it: every condition, validator and action is a typed
 * node from a fixed catalogue, so a definition can be read by an auditor,
 * checked statically (cycles, unreachable statuses) and replayed. Scripting
 * (YouTrack JS, ScriptRunner) is deliberately absent; see the design, §9.
 *
 * The four verbs follow Jira's 2024 editor: Restrict (who may), Request input
 * (what to ask), Validate (what must hold), Perform (what to do).
 */
import { z } from "zod";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

/** Size caps: a definition is evaluated on every status change (design §9). */
export const LIMITS = {
  statuses: 64,
  transitions: 500,
  actionsPerTransition: 20,
  conditionDepth: 8,
  /** Children of an all/any group, and values in a list (`in`, a field's list value). */
  conditionItems: 50,
  /** Every node in one transition's restriction, groups included. */
  conditionNodes: 200,
} as const;

/** The org and project roles a restriction can name: a typo is refused, not a silent permanent "no". */
export const ORG_ROLES = ["OWNER", "ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER", "GUEST"] as const;
export const PROJECT_ROLES = ["MANAGER", "LEAD", "MEMBER", "VIEWER"] as const;

export const SYSTEM_FIELDS = [
  "assigneeId",
  "priority",
  "storyPoints",
  "dueDate",
  "startDate",
  "intervalId",
  "teamId",
  "description",
  "resolution",
  "workCategory",
  "labels",
  // The cancel reason and note: inputs of a transition into Cancelled.
  "cancelReason",
  "cancelNote",
] as const;
export type SystemField = (typeof SYSTEM_FIELDS)[number];

export const fieldRefSchema = z.union([
  z.object({ system: z.enum(SYSTEM_FIELDS) }).strict(),
  z.object({ custom: z.string().min(1).max(100) }).strict(),
]);
export type FieldRef = z.infer<typeof fieldRefSchema>;

/** The ABAC engine's operators, plus emptiness checks for fields. */
export const COMPARE_OPERATORS = ["eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "contains"] as const;
export type CompareOperator = (typeof COMPARE_OPERATORS)[number];

const permissionKeySchema = z
  .string()
  .refine((k): k is PermissionKey => Object.prototype.hasOwnProperty.call(Permission, k), "Unknown permission");

export const LINK_TYPES = ["BLOCKS", "BLOCKED_BY", "RELATES", "DUPLICATES", "PREDECESSOR", "SUCCESSOR", "CLONES"] as const;

const conditionValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()])).max(LIMITS.conditionItems)]);

export type ConditionNode =
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | { not: ConditionNode }
  | { kind: "actorHasPermission"; permission: PermissionKey }
  | { kind: "actorOrgRole"; in: string[] }
  | { kind: "actorProjectRole"; in: string[] }
  | { kind: "actorInTeam"; teamId: string }
  | { kind: "actorIsAssignee" }
  | { kind: "actorIsCreator" }
  | { kind: "actorIsNot"; ref: "lastTransitionActor"; transitionId: string }
  | { kind: "field"; field: FieldRef; op: CompareOperator | "isEmpty" | "isNotEmpty"; value?: z.infer<typeof conditionValue> }
  | { kind: "previousStatus"; in: string[] };

export const conditionSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema).min(1).max(LIMITS.conditionItems) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1).max(LIMITS.conditionItems) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    z.object({ kind: z.literal("actorHasPermission"), permission: permissionKeySchema }).strict(),
    z.object({ kind: z.literal("actorOrgRole"), in: z.array(z.enum(ORG_ROLES)).min(1).max(LIMITS.conditionItems) }).strict(),
    z.object({ kind: z.literal("actorProjectRole"), in: z.array(z.enum(PROJECT_ROLES)).min(1).max(LIMITS.conditionItems) }).strict(),
    // "item" = the item's own team.
    z.object({ kind: z.literal("actorInTeam"), teamId: z.string().min(1) }).strict(),
    z.object({ kind: z.enum(["actorIsAssignee", "actorIsCreator"]) }).strict(),
    z.object({ kind: z.literal("actorIsNot"), ref: z.literal("lastTransitionActor"), transitionId: z.string().min(1) }).strict(),
    z
      .object({
        kind: z.literal("field"),
        field: fieldRefSchema,
        op: z.enum([...COMPARE_OPERATORS, "isEmpty", "isNotEmpty"]),
        value: conditionValue.optional(),
      })
      .strict(),
    z.object({ kind: z.literal("previousStatus"), in: z.array(z.string()).min(1).max(LIMITS.conditionItems) }).strict(),
  ]),
) as z.ZodType<ConditionNode>;

export const validatorSchema = z.union([
  z.object({ kind: z.literal("fieldsRequired"), fields: z.array(fieldRefSchema).min(1) }).strict(),
  z.object({ kind: z.literal("childrenSettled") }).strict(),
  z.object({ kind: z.literal("linksSettled"), linkType: z.enum(LINK_TYPES) }).strict(),
  z.object({ kind: z.literal("wipLimit"), scope: z.literal("board"), hard: z.literal(true) }).strict(),
  z.object({ kind: z.literal("intervalRequired") }).strict(),
  z.object({ kind: z.literal("cancelReason") }).strict(),
  z
    .object({
      kind: z.literal("field"),
      field: fieldRefSchema,
      op: z.enum(COMPARE_OPERATORS),
      value: conditionValue,
      message: z.string().min(1).max(300),
    })
    .strict(),
]);
export type ValidatorSpec = z.infer<typeof validatorSchema>;

/** A value an action writes: a literal, or one of a few computed values. */
const valueExpr = z.union([
  z.object({ literal: conditionValue }).strict(),
  z.object({ now: z.literal(true) }).strict(),
  z.object({ actor: z.literal(true) }).strict(),
]);
export type ValueExpr = z.infer<typeof valueExpr>;

export const postActionSchema = z.union([
  z.object({ kind: z.literal("setField"), field: fieldRefSchema, value: valueExpr }).strict(),
  z.object({ kind: z.literal("clearField"), field: fieldRefSchema }).strict(),
  z
    .object({
      kind: z.literal("assign"),
      to: z.union([z.enum(["actor", "creator", "unassigned"]), z.object({ userId: z.string().uuid() }).strict()]),
    })
    .strict(),
  z.object({ kind: z.enum(["addLabels", "removeLabels"]), labels: z.array(z.string().min(1).max(60)).min(1).max(20) }).strict(),
  z.object({ kind: z.literal("addComment"), body: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal("addWatcher"), who: z.enum(["actor", "assignee"]) }).strict(),
]);
export type PostActionSpec = z.infer<typeof postActionSchema>;

const statusKey = z.string().min(1).max(120);

export const transitionSchema = z
  .object({
    /** Stable across versions; automations reference it. */
    id: z.string().min(1).max(64),
    /** The button label: "Start work", "Resolve". */
    name: z.string().min(1).max(80),
    /** "*" = a global transition, from any status. */
    from: z.union([z.literal("*"), z.array(statusKey).min(1)]),
    to: statusKey,
    restrict: conditionSchema.optional(),
    input: z
      .array(z.object({ field: fieldRefSchema, required: z.boolean(), label: z.string().max(80).optional() }).strict())
      .max(20)
      .optional(),
    validate: z.array(validatorSchema).max(20).optional(),
    actions: z.array(postActionSchema).max(LIMITS.actionsPerTransition).optional(),
    /** Not offered to people: system and automation only (e.g. "Merge"). */
    hidden: z.boolean().optional(),
  })
  .strict()
  // Enforced on every parse, not only at publish, so a stored or posted
  // definition can't carry a condition tree deeper than the evaluator allows.
  .refine((t) => !t.restrict || conditionNodes(t.restrict) <= LIMITS.conditionNodes, {
    message: `Conditions have more than ${LIMITS.conditionNodes} parts.`,
    path: ["restrict"],
  })
  .refine((t) => !t.restrict || conditionDepth(t.restrict) <= LIMITS.conditionDepth, {
    message: `Conditions nest more than ${LIMITS.conditionDepth} deep.`,
    path: ["restrict"],
  });
export type TransitionSpec = z.infer<typeof transitionSchema>;

export const workflowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    statuses: z
      .array(
        z
          .object({
            key: statusKey,
            isInitial: z.literal(true).optional(),
            fieldRules: z
              .array(z.object({ field: fieldRefSchema, rule: z.enum(["required", "readOnly"]) }).strict())
              .max(50)
              .optional(),
            timers: z
              .array(
                z
                  .object({ id: z.string().min(1).max(64), afterMs: z.number().int().positive(), event: z.literal("status.timer") })
                  .strict(),
              )
              .max(10)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(LIMITS.statuses),
    transitions: z.array(transitionSchema).max(LIMITS.transitions),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** A project status as validation needs it. */
export interface StatusRef {
  key: string;
  category: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";
  archived?: boolean;
}

export interface DefinitionIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

/** The checks in a restriction, without the groups around them. */
function conditionLeaves(node: ConditionNode | undefined): Exclude<ConditionNode, { all: unknown } | { any: unknown } | { not: unknown }>[] {
  if (!node) return [];
  if ("all" in node) return node.all.flatMap(conditionLeaves);
  if ("any" in node) return node.any.flatMap(conditionLeaves);
  if ("not" in node) return conditionLeaves(node.not);
  return [node];
}

function conditionNodes(node: ConditionNode): number {
  if ("all" in node) return 1 + node.all.reduce((n, c) => n + conditionNodes(c), 0);
  if ("any" in node) return 1 + node.any.reduce((n, c) => n + conditionNodes(c), 0);
  if ("not" in node) return 1 + conditionNodes(node.not);
  return 1;
}

function conditionDepth(node: ConditionNode): number {
  if ("all" in node) return 1 + Math.max(0, ...node.all.map(conditionDepth));
  if ("any" in node) return 1 + Math.max(0, ...node.any.map(conditionDepth));
  if ("not" in node) return 1 + conditionDepth(node.not);
  return 1;
}

/**
 * Check a parsed definition against the project's statuses: the invariants
 * that make it safe to publish (errors) and the shapes that are probably
 * mistakes (warnings).
 */
export function validateDefinition(def: WorkflowDefinition, statuses: readonly StatusRef[]): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const error = (code: string, message: string) => issues.push({ severity: "error", code, message });
  const warn = (code: string, message: string) => issues.push({ severity: "warning", code, message });

  const projectStatus = new Map(statuses.map((s) => [s.key, s]));
  const used = new Set<string>();
  for (const s of def.statuses) {
    if (used.has(s.key)) error("DUPLICATE_STATUS", `Status "${s.key}" is listed twice.`);
    used.add(s.key);
    if (!projectStatus.has(s.key)) error("UNKNOWN_STATUS", `Status "${s.key}" does not exist in this project.`);
  }

  const initial = def.statuses.filter((s) => s.isInitial);
  if (initial.length !== 1) error("INITIAL_STATUS", `Exactly one status must be the initial one (found ${initial.length}).`);
  else if (projectStatus.get(initial[0].key)?.archived) error("INITIAL_ARCHIVED", "The initial status is archived.");

  const categories = new Set(def.statuses.map((s) => projectStatus.get(s.key)?.category).filter(Boolean));
  if (!categories.has("TODO")) error("NO_TODO", "The workflow needs at least one To Do status.");
  if (!categories.has("DONE")) error("NO_DONE", "The workflow needs at least one Done status.");

  const ids = new Set<string>();
  for (const t of def.transitions) {
    if (ids.has(t.id)) error("DUPLICATE_TRANSITION", `Transition id "${t.id}" is used twice.`);
    ids.add(t.id);
    if (!used.has(t.to)) error("UNKNOWN_TARGET", `"${t.name}" goes to "${t.to}", which this workflow does not use.`);
    if (t.from !== "*") {
      for (const f of t.from) {
        if (!used.has(f)) error("UNKNOWN_SOURCE", `"${t.name}" starts from "${f}", which this workflow does not use.`);
      }
    }
    for (const n of conditionLeaves(t.restrict)) {
      // A restriction naming something the workflow doesn't have is a "no" for everyone, for good.
      if (n.kind === "previousStatus") {
        for (const k of n.in) if (!projectStatus.has(k)) error("UNKNOWN_STATUS", `"${t.name}" checks a previous status "${k}" that doesn't exist in this project.`);
      }
      if (n.kind === "actorIsNot" && !def.transitions.some((o) => o.id === n.transitionId)) {
        error("UNKNOWN_TRANSITION", `"${t.name}" refers to a transition "${n.transitionId}" this workflow doesn't have.`);
      }
    }
    if (t.restrict && conditionDepth(t.restrict) > LIMITS.conditionDepth) {
      error("CONDITION_TOO_DEEP", `"${t.name}" nests its conditions more than ${LIMITS.conditionDepth} deep.`);
    }
    const intoCancelled = projectStatus.get(t.to)?.category === "CANCELLED";
    if (t.validate?.some((v) => v.kind === "cancelReason") && !intoCancelled) {
      error("CANCEL_REASON_TARGET", `"${t.name}" asks for a cancel reason but does not go to a Cancelled status.`);
    }
  }

  // Reachability from the initial status, following every transition a person
  // could take (hidden ones are system moves, and still count as a way in).
  if (initial.length === 1) {
    const reached = new Set([initial[0].key]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of def.transitions) {
        if (reached.has(t.to)) continue;
        if (t.from === "*" || t.from.some((f) => reached.has(f))) {
          reached.add(t.to);
          grew = true;
        }
      }
    }
    for (const s of def.statuses) {
      if (!reached.has(s.key)) warn("UNREACHABLE", `No transition leads to "${s.key}" from the initial status.`);
    }
  }

  // A status nothing leaves is a dead end, which is fine for Done and Cancelled.
  for (const s of def.statuses) {
    const category = projectStatus.get(s.key)?.category;
    if (category === "DONE" || category === "CANCELLED") continue;
    const exits = def.transitions.some((t) => t.to !== s.key && (t.from === "*" || t.from.includes(s.key)));
    if (!exits) warn("NO_EXIT", `Nothing leaves "${s.key}", so work there can never move on.`);
  }

  return issues;
}

/** {from status key: to status key}, for items in statuses a change drops. */
export type MigrationMap = Record<string, string>;

/**
 * Editor-only data kept with a version (never read by the engine): node
 * positions, and on a template the statuses it brings into a project.
 */
export interface VersionLayout {
  nodes?: Record<string, { x: number; y: number }>;
  statusCatalog?: { key: string; name: string; color: string; category: StatusRef["category"] }[];
}
