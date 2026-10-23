/**
 * "Perform actions": a transition's user actions, folded into the change.
 *
 * Field actions become part of the item's patch, so they are written, audited
 * and recorded in history exactly like the fields a person sets, and the
 * system steps (dates, cancel fields) run after them. Comments and watchers
 * come back as side writes for the engine to make in the same transaction.
 *
 * Pure. Notifications, webhooks and cross-item effects are not actions: they
 * are automations, which run after commit (design §3.3).
 */
import type { WorkItemPatch } from "@/lib/work-items/apply-change.server";
import type { FieldRef, PostActionSpec, ValueExpr } from "@/lib/workflow/definition";

export interface ActionItem {
  createdById: string;
  assigneeId: string | null;
  tags: readonly string[];
}

export interface ActionResult {
  patch: WorkItemPatch;
  comments: string[];
  watchers: string[];
}

/** Patch keys a system field writes to. Labels are handled apart. */
const PATCH_KEY: Partial<Record<Extract<FieldRef, { system: string }>["system"], keyof WorkItemPatch>> = {
  assigneeId: "assigneeId",
  priority: "priority",
  storyPoints: "storyPoints",
  dueDate: "dueDate",
  startDate: "startDate",
  intervalId: "intervalId",
  teamId: "teamId",
  description: "description",
  workCategory: "workCategory",
  resolution: "resolution",
};

function resolveValue(v: ValueExpr, actorId: string, now: Date): unknown {
  if ("now" in v) return now.toISOString();
  if ("actor" in v) return actorId;
  return v.literal;
}

/**
 * Apply `actions`, in order, on top of `patch`. A value the person sent in the
 * same request is overwritten only by an action that names the same field,
 * which is the point of the action.
 */
export function applyActions(
  actions: readonly PostActionSpec[],
  args: { patch: WorkItemPatch; item: ActionItem; actorId: string; now: Date },
): ActionResult {
  const patch: WorkItemPatch = { ...args.patch };
  const comments: string[] = [];
  const watchers: string[] = [];
  let tags = patch.tags ?? [...args.item.tags];
  const setField = (field: FieldRef, value: unknown) => {
    if ("custom" in field) {
      patch.customFields = { ...(patch.customFields ?? {}), [field.custom]: value };
    } else if (field.system === "labels") {
      tags = Array.isArray(value) ? value.map(String) : [];
      patch.tags = tags;
    } else {
      const key = PATCH_KEY[field.system];
      if (key) (patch as Record<string, unknown>)[key] = value;
    }
  };

  for (const action of actions) {
    switch (action.kind) {
      case "setField":
        setField(action.field, resolveValue(action.value, args.actorId, args.now));
        break;
      case "clearField":
        setField(action.field, null);
        break;
      case "assign": {
        const to = action.to;
        patch.assigneeId =
          to === "actor" ? args.actorId : to === "creator" ? args.item.createdById : to === "unassigned" ? null : to.userId;
        delete patch.assigneeIds;
        break;
      }
      case "addLabels":
        tags = [...tags, ...action.labels.filter((l) => !tags.some((t) => t.toLowerCase() === l.toLowerCase()))];
        patch.tags = tags;
        break;
      case "removeLabels": {
        const drop = new Set(action.labels.map((l) => l.toLowerCase()));
        tags = tags.filter((t) => !drop.has(t.toLowerCase()));
        patch.tags = tags;
        break;
      }
      case "addComment":
        comments.push(action.body);
        break;
      case "addWatcher": {
        const who = action.who === "actor" ? args.actorId : (patch.assigneeId ?? args.item.assigneeId);
        if (who) watchers.push(who);
        break;
      }
    }
  }
  return { patch, comments, watchers };
}
