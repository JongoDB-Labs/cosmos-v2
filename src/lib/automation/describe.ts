/**
 * A rule in a sentence, for the Automations list: "When an item moves to Done,
 * on its parent, if every child is done or cancelled: move to Done." Client-safe.
 */
import type { AutomationAction, AutomationSpec } from "./spec";

export const CATEGORY_LABELS: Record<string, string> = { TODO: "To do", IN_PROGRESS: "In progress", DONE: "Done", CANCELLED: "Cancelled" };

export const FIELD_LABELS: Record<string, string> = {
  assigneeId: "assignee",
  priority: "priority",
  dueDate: "due date",
  startDate: "start date",
  storyPoints: "story points",
  teamId: "team",
  intervalId: "sprint",
  parentId: "parent",
  workItemTypeId: "type",
  tags: "labels",
  title: "title",
  description: "description",
};

const list = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);
const pad = (n: number) => String(n).padStart(2, "0");

export function describeTrigger(t: AutomationSpec["trigger"], statusName: (key: string) => string): string {
  switch (t.on) {
    case "item.created":
      return "When an item is created";
    case "item.updated":
      return t.fields?.length ? `When an item's ${list(t.fields.map((f) => FIELD_LABELS[f] ?? f))} changes` : "When an item changes";
    case "item.transitioned": {
      const to = [...(t.to ?? []).map(statusName), ...(t.toCategory ?? []).map((c) => `any ${CATEGORY_LABELS[c]} status`)];
      const from = t.from?.length ? ` from ${list(t.from.map(statusName))}` : "";
      return `When an item moves${from}${to.length ? ` to ${list(to)}` : ""}`;
    }
    case "schedule": {
      const at = `${pad(t.hour)}:${pad(t.minute)} UTC`;
      const when = t.every === "hour" ? `Every hour at :${pad(t.minute)}` : t.every === "day" ? `Every day at ${at}` : `Every Monday at ${at}`;
      return `${when}, for items matching ${t.cql}`;
    }
  }
}

export function describeAction(a: AutomationAction, statusName: (key: string) => string): string {
  switch (a.kind) {
    case "transition":
      return `move to ${statusName(a.to)}${a.cancel ? ` (${a.cancel.reason === "OBE" ? "overcome by events" : "other"})` : ""}`;
    case "setField": {
      const label = FIELD_LABELS[a.field] ?? a.field;
      if (a.value === null) return `clear the ${label}`;
      if (a.field === "dueDate" || a.field === "startDate") {
        const d = (a.value as { daysFromNow: number }).daysFromNow;
        return `set the ${label} to ${d === 0 ? "today" : d > 0 ? `${d} days from now` : `${-d} days ago`}`;
      }
      if (a.field === "teamId" || a.field === "intervalId") return `set the ${label}`;
      return `set the ${label} to ${String(a.value).toLowerCase()}`;
    }
    case "assign":
      return a.to === "triggerActor" ? "assign to whoever made the change" : a.to === "unassigned" ? "unassign" : "assign to someone";
    case "addLabels":
      return `add ${a.labels.join(", ")}`;
    case "removeLabels":
      return `remove ${a.labels.join(", ")}`;
    case "addComment":
      return "comment";
    case "notify":
      return typeof a.to === "object" ? `notify ${a.to.userIds.length} ${a.to.userIds.length === 1 ? "person" : "people"}` : `notify the ${a.to === "triggerActor" ? "person who made the change" : a.to}`;
    case "webhook":
      return "send a webhook";
    case "archive":
      return "archive";
  }
}

export function describeRule(spec: AutomationSpec, statusName: (key: string) => string): string {
  const parts = [describeTrigger(spec.trigger, statusName)];
  if (spec.scope === "parent") parts.push("on its parent");
  if (spec.scope === "children") parts.push("on its children");
  if (spec.condition?.cql) parts.push(`if it matches ${spec.condition.cql}`);
  if (spec.condition?.childrenAll) parts.push(`if every child is ${list(spec.condition.childrenAll.categories.map((c) => CATEGORY_LABELS[c].toLowerCase()))}`);
  const actions = spec.actions.map((a) => describeAction(a, statusName));
  return `${parts.join(", ")}: ${actions.join(", then ")}.`;
}
