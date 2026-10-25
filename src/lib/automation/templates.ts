/**
 * The rules a project can start from (workflow design §5.3, "templates shipped
 * in v1"): one click makes an ordinary rule, editable after like any other. A
 * template only fills in a spec; it asks for what the project has to say (which
 * status is Done here, how many days is stale) and nothing else.
 *
 * Client-safe: the Automations screen builds the spec, and the server checks it
 * as it checks any rule. Two of §5.3's rows aren't here: "PR merged → Done"
 * waits for the GitHub connector (Phase 5), and "sprint completed → move
 * unfinished on" is already the sprint's Complete dialog.
 */
import type { AutomationSpec } from "./spec";

export type Category = "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";

/** What a template asks for. A status is picked from the project's, limited to the categories it suits. */
export type TemplateParam =
  | { key: string; kind: "status"; label: string; categories: readonly Category[] }
  | { key: string; kind: "days"; label: string; default: number; min: number; max: number };

export interface AutomationTemplate {
  key: string;
  name: string;
  description: string;
  params: readonly TemplateParam[];
  build: (values: Record<string, string | number>) => AutomationSpec;
}

const DEFAULTS = { scope: "trigger", options: { includeImports: false } } as const;

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    key: "parent-done-with-children",
    name: "Parent follows children: done",
    description: "When the last open child is done or cancelled, move its parent to Done.",
    params: [{ key: "done", kind: "status", label: "Move the parent to", categories: ["DONE"] }],
    build: (v) => ({
      ...DEFAULTS,
      trigger: { on: "item.transitioned", toCategory: ["DONE", "CANCELLED"] },
      scope: "parent",
      condition: { cql: "statusCategory IN (TODO, IN_PROGRESS)", childrenAll: { categories: ["DONE", "CANCELLED"] } },
      actions: [{ kind: "transition", to: String(v.done) }],
    }),
  },
  {
    key: "parent-starts-with-child",
    name: "Parent follows children: started",
    description: "When a child is started, move its parent to In Progress if it hasn't started yet.",
    params: [{ key: "started", kind: "status", label: "Move the parent to", categories: ["IN_PROGRESS"] }],
    build: (v) => ({
      ...DEFAULTS,
      trigger: { on: "item.transitioned", toCategory: ["IN_PROGRESS"] },
      scope: "parent",
      condition: { cql: "statusCategory = TODO" },
      actions: [{ kind: "transition", to: String(v.started) }],
    }),
  },
  {
    key: "close-stale",
    name: "Close stale items",
    description: "Every day, cancel open items nobody has touched for a while that aren't in an active sprint, as overcome by events.",
    params: [
      { key: "days", kind: "days", label: "Untouched for (days)", default: 30, min: 1, max: 3650 },
      { key: "cancelled", kind: "status", label: "Move them to", categories: ["CANCELLED"] },
    ],
    build: (v) => ({
      ...DEFAULTS,
      trigger: { on: "schedule", every: "day", hour: 6, minute: 0, cql: `statusCategory IN (TODO, IN_PROGRESS) AND updated < -${v.days}d AND (sprint IS EMPTY OR sprint NOT IN openSprints())` },
      actions: [
        { kind: "transition", to: String(v.cancelled), cancel: { reason: "OBE" } },
        { kind: "addComment", body: `Cancelled by "{{rule.name}}": no one had updated it for ${v.days} days.` },
      ],
    }),
  },
  {
    key: "archive-closed",
    name: "Archive closed items",
    description: "Every day, archive items that were finished or cancelled a while ago.",
    params: [{ key: "days", kind: "days", label: "Closed for (days)", default: 90, min: 1, max: 3650 }],
    build: (v) => ({
      ...DEFAULTS,
      trigger: { on: "schedule", every: "day", hour: 5, minute: 0, cql: `statusCategory IN (DONE, CANCELLED) AND updated < -${v.days}d` },
      actions: [{ kind: "archive" }],
    }),
  },
  {
    key: "assign-on-start",
    name: "Assign on start",
    description: "When someone starts an unassigned item, assign it to them.",
    params: [],
    build: () => ({
      ...DEFAULTS,
      trigger: { on: "item.transitioned", toCategory: ["IN_PROGRESS"] },
      condition: { cql: "assignee IS EMPTY" },
      actions: [{ kind: "assign", to: "triggerActor" }],
    }),
  },
  {
    key: "status-reminder",
    name: "Reminder: stuck in a status",
    description: "Every day, remind the assignee of items that have sat in one status for too long.",
    params: [
      { key: "status", kind: "status", label: "Status", categories: ["TODO", "IN_PROGRESS"] },
      { key: "days", kind: "days", label: "For more than (days)", default: 7, min: 1, max: 365 },
    ],
    build: (v) => ({
      ...DEFAULTS,
      trigger: { on: "schedule", every: "day", hour: 8, minute: 0, cql: `status = "${v.status}" AND statusChanged < -${v.days}d AND assignee IS NOT EMPTY` },
      actions: [{ kind: "notify", to: "assignee", message: `{{item.key}} has been in {{item.status}} for more than ${v.days} days.` }],
    }),
  },
  {
    key: "notify-on-done",
    name: "Tell the reporter when it's done",
    description: "When an item is done, notify the person who created it.",
    params: [],
    build: () => ({
      ...DEFAULTS,
      trigger: { on: "item.transitioned", toCategory: ["DONE"] },
      actions: [{ kind: "notify", to: "creator", message: "{{item.key}} {{item.title}} is done ({{actor.name}})." }],
    }),
  },
];

export function templateByKey(key: string | null | undefined): AutomationTemplate | undefined {
  return AUTOMATION_TEMPLATES.find((t) => t.key === key);
}
