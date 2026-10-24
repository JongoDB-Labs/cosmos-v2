/**
 * Evaluating a transition's "Restrict" conditions against an actor and an item.
 *
 * Fail-closed, with the ABAC engine's rules (`src/lib/abac/engine.ts`): each
 * node is true, false or UNRESOLVABLE (the data it needs is absent), and a
 * restriction holds only when the whole tree is definitively true. An unknown
 * node kind, a field path that walks into a prototype, or a fact the caller
 * did not supply all hide the transition rather than show it.
 *
 * Restrictions only ever NARROW: the actor must already hold ITEM_UPDATE for
 * the item (checked by the route) before any transition is considered, so no
 * condition can grant a right the actor lacks.
 */
import { compare, safeGet } from "@/lib/abac/engine";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import type { ConditionNode, FieldRef } from "@/lib/workflow/definition";

export type Tri = "true" | "false" | "unresolvable";

export interface ConditionActor {
  userId: string;
  orgRole: string;
  /** Effective org permissions. */
  permissions: bigint;
  /** The actor's role in the item's project, if a member. */
  projectRole?: string | null;
  /** Teams the actor belongs to in the item's project. */
  teamIds?: readonly string[];
}

export interface ConditionItem {
  createdById: string;
  assigneeIds: readonly string[];
  teamId: string | null;
  /** System field values by name (`priority`, `dueDate`, …). */
  fields: Readonly<Record<string, unknown>>;
  customFields: Readonly<Record<string, unknown>>;
}

export interface ConditionHistory {
  /** The status the item was in before its current one, if known. */
  previousStatus?: string | null;
  /** Who last ran each transition on this item, by transition id. */
  lastTransitionActor?: Readonly<Record<string, string>>;
}

export interface ConditionContext {
  actor: ConditionActor;
  /** Absent when asking about a status in general, not an item: what depends on the item is then unresolvable. */
  item?: ConditionItem;
  history?: ConditionHistory;
}

/** A field's value on the item, or `undefined` when the item lacks it. */
export function fieldValue(item: ConditionItem, field: FieldRef): unknown {
  return "system" in field
    ? safeGet(item.fields, field.system)
    : safeGet(item.customFields, field.custom);
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

const not = (r: Tri): Tri => (r === "true" ? "false" : r === "false" ? "true" : r);
const tri = (b: boolean): Tri => (b ? "true" : "false");

export function evaluateCondition(node: ConditionNode, ctx: ConditionContext): Tri {
  if (!node || typeof node !== "object") return "unresolvable";

  if ("all" in node) {
    // False beats unresolvable: one definite failure decides an AND.
    const results = node.all.map((n) => evaluateCondition(n, ctx));
    if (results.includes("false")) return "false";
    return results.includes("unresolvable") || results.length === 0 ? "unresolvable" : "true";
  }
  if ("any" in node) {
    const results = node.any.map((n) => evaluateCondition(n, ctx));
    if (results.includes("true")) return "true";
    return results.includes("unresolvable") || results.length === 0 ? "unresolvable" : "false";
  }
  if ("not" in node) return not(evaluateCondition(node.not, ctx));

  const { actor, item, history } = ctx;
  switch (node.kind) {
    case "actorHasPermission": {
      if (!Object.prototype.hasOwnProperty.call(Permission, node.permission)) return "unresolvable";
      return tri(hasPermission(actor.permissions, Permission[node.permission]));
    }
    case "actorOrgRole":
      return tri(node.in.includes(actor.orgRole));
    case "actorProjectRole":
      if (actor.projectRole === undefined) return "unresolvable";
      return tri(actor.projectRole !== null && node.in.includes(actor.projectRole));
    case "actorInTeam": {
      if (actor.teamIds === undefined) return "unresolvable";
      if (node.teamId === "item" && !item) return "unresolvable";
      const teamId = node.teamId === "item" ? item!.teamId : node.teamId;
      return tri(teamId !== null && actor.teamIds.includes(teamId));
    }
    case "actorIsAssignee":
      return item ? tri(item.assigneeIds.includes(actor.userId)) : "unresolvable";
    case "actorIsCreator":
      return item ? tri(item.createdById === actor.userId) : "unresolvable";
    case "actorIsNot": {
      const last = history?.lastTransitionActor;
      if (last === undefined) return "unresolvable";
      // Nobody has run it yet: there is no one to separate from.
      if (!Object.prototype.hasOwnProperty.call(last, node.transitionId)) return "true";
      return tri(last[node.transitionId] !== actor.userId);
    }
    case "previousStatus":
      if (history?.previousStatus === undefined) return "unresolvable";
      return tri(history.previousStatus !== null && node.in.includes(history.previousStatus));
    case "field": {
      if (!item) return "unresolvable";
      const value = fieldValue(item, node.field);
      if (node.op === "isEmpty") return tri(isEmpty(value));
      if (node.op === "isNotEmpty") return tri(!isEmpty(value));
      if (value === undefined) return "unresolvable";
      return tri(compare(value, node.op, node.value));
    }
    default:
      return "unresolvable";
  }
}

/**
 * Could the restriction let this actor take the transition on SOME item? False
 * only when it definitely can't (a missing permission or role); what depends
 * on the item counts as possible. For dimming a board's columns ahead of a
 * move, never for deciding one.
 */
export function restrictionMayAllow(restrict: ConditionNode | undefined, actor: ConditionActor): boolean {
  return restrict === undefined || evaluateCondition(restrict, { actor }) !== "false";
}

/** Does the restriction let this actor see and run the transition? */
export function restrictionAllows(restrict: ConditionNode | undefined, ctx: ConditionContext): boolean {
  return restrict === undefined || evaluateCondition(restrict, ctx) === "true";
}
