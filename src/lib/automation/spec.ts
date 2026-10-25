/**
 * An automation rule (workflow design §5.3, as approved in P4: conditions are
 * CQL, Q8): WHEN a trigger fires, IF the item matches, THEN run the actions.
 * Client-safe, so the rule builder (P4c) validates in the browser with the
 * same schema the server stores.
 *
 * Every action goes through the same writer as a person's edit, as the rule's
 * owner capped at what they could do when they saved it (Q7), so a rule can
 * never do what its owner couldn't, nor what the item's workflow forbids.
 */
import { z } from "zod";
import { CANCEL_NOTE_MAX, PICKABLE_CANCEL_REASONS } from "@/lib/work-items/cancel";

export const AUTOMATION_LIMITS = {
  actions: 20,
  cqlLength: 4_000,
  templateLength: 2_000,
  labels: 20,
  recipients: 20,
  /** Items one scheduled run may act on. */
  scheduledItems: 500,
  /** Items a scope (children) may fan out to for one event. */
  scopedItems: 200,
  /** Automation chain depth beyond which a run is a LOOP. */
  depth: 10,
} as const;

const statusKey = z.string().min(1).max(64);
const uuid = z.string().uuid();
export const CATEGORIES = ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"] as const;

/** Fields an "item.updated" trigger can watch. Named as the outbox names them. */
export const WATCHABLE_FIELDS = [
  "assigneeId", "priority", "dueDate", "startDate", "storyPoints", "teamId", "intervalId", "parentId", "workItemTypeId", "tags", "title", "description",
] as const;

export const triggerSchema = z.discriminatedUnion("on", [
  z.object({ on: z.literal("item.created") }).strict(),
  z.object({ on: z.literal("item.updated"), fields: z.array(z.enum(WATCHABLE_FIELDS)).min(1).max(20).optional() }).strict(),
  z
    .object({
      on: z.literal("item.transitioned"),
      from: z.array(statusKey).min(1).max(50).optional(),
      to: z.array(statusKey).min(1).max(50).optional(),
      toCategory: z.array(z.enum(CATEGORIES)).min(1).max(4).optional(),
    })
    .strict(),
  z
    .object({
      on: z.literal("schedule"),
      /** Hourly at :minute, or daily / weekly (Mondays) at hour:minute UTC. */
      every: z.enum(["hour", "day", "week"]),
      hour: z.number().int().min(0).max(23).default(0),
      minute: z.number().int().min(0).max(59).default(0),
      /** The items a scheduled run acts on. */
      cql: z.string().min(1).max(AUTOMATION_LIMITS.cqlLength),
    })
    .strict(),
]);
export type AutomationTrigger = z.infer<typeof triggerSchema>;

/** `{{item.key}}` and the like; see template.ts for what each sink may name. */
const templateString = z.string().min(1).max(AUTOMATION_LIMITS.templateLength);

const setFieldAction = z.discriminatedUnion("field", [
  z.object({ kind: z.literal("setField"), field: z.literal("priority"), value: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]) }).strict(),
  z.object({ kind: z.literal("setField"), field: z.literal("storyPoints"), value: z.number().int().min(0).max(1000).nullable() }).strict(),
  z.object({ kind: z.literal("setField"), field: z.literal("teamId"), value: uuid.nullable() }).strict(),
  z.object({ kind: z.literal("setField"), field: z.literal("intervalId"), value: uuid.nullable() }).strict(),
  z
    .object({
      kind: z.literal("setField"),
      field: z.enum(["dueDate", "startDate"]),
      /** Days from when the rule runs (0 = today), or null to clear. */
      value: z.object({ daysFromNow: z.number().int().min(-3650).max(3650) }).strict().nullable(),
    })
    .strict(),
]);

export const actionSchema = z.union([
  z
    .object({
      kind: z.literal("transition"),
      to: statusKey,
      /** Why, when `to` is a Cancelled status; ignored for any other. "Other" needs a note. */
      cancel: z.object({ reason: z.enum(PICKABLE_CANCEL_REASONS), note: z.string().max(CANCEL_NOTE_MAX).optional() }).strict().optional(),
    })
    .strict(),
  setFieldAction,
  z
    .object({
      kind: z.literal("assign"),
      /** A member, the person whose change fired the rule, or nobody. */
      to: z.union([z.object({ userId: uuid }).strict(), z.literal("triggerActor"), z.literal("unassigned")]),
    })
    .strict(),
  z.object({ kind: z.enum(["addLabels", "removeLabels"]), labels: z.array(z.string().min(1).max(100)).min(1).max(AUTOMATION_LIMITS.labels) }).strict(),
  z.object({ kind: z.literal("addComment"), body: templateString }).strict(),
  z
    .object({
      kind: z.literal("notify"),
      to: z.union([
        z.enum(["assignee", "creator", "triggerActor"]),
        z.object({ userIds: z.array(uuid).min(1).max(AUTOMATION_LIMITS.recipients) }).strict(),
      ]),
      message: templateString,
    })
    .strict(),
  /** An existing webhook of the org, never a raw URL; delivers ids and keys only. */
  z.object({ kind: z.literal("webhook"), webhookId: uuid }).strict(),
  z.object({ kind: z.literal("archive") }).strict(),
]);
export type AutomationAction = z.infer<typeof actionSchema>;

export const automationSpecSchema = z
  .object({
    trigger: triggerSchema,
    /**
     * The item (or each scoped item) must match all that's given: a CQL query,
     * and that every one of its children is in one of these categories (an
     * item with no children doesn't match). Absent: every item.
     */
    condition: z
      .object({
        cql: z.string().min(1).max(AUTOMATION_LIMITS.cqlLength).optional(),
        childrenAll: z.object({ categories: z.array(z.enum(CATEGORIES)).min(1).max(4) }).strict().optional(),
      })
      .strict()
      .refine((c) => c.cql !== undefined || c.childrenAll !== undefined, { message: "A condition needs a query or a children check." })
      .optional(),
    /** Run the actions on the trigger item, its parent, or its children. Not for schedules. */
    scope: z.enum(["trigger", "parent", "children"]).default("trigger"),
    actions: z.array(actionSchema).min(1).max(AUTOMATION_LIMITS.actions),
    options: z
      .object({
        /** Run on changes an import made too. Off: a large import would run every rule over every row. */
        includeImports: z.boolean().default(false),
      })
      .strict()
      .default({ includeImports: false }),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.trigger.on === "schedule" && s.scope !== "trigger") {
      ctx.addIssue({ code: "custom", path: ["scope"], message: "A scheduled rule acts on the items its query finds." });
    }
    if (s.trigger.on === "schedule" && s.condition) {
      ctx.addIssue({ code: "custom", path: ["condition"], message: "Put a scheduled rule's condition in its query." });
    }
    if (s.trigger.on === "schedule" && s.actions.some((a) => a.kind === "assign" && a.to === "triggerActor")) {
      ctx.addIssue({ code: "custom", path: ["actions"], message: "A scheduled rule has no person whose change fired it." });
    }
  });
export type AutomationSpec = z.infer<typeof automationSpecSchema>;
