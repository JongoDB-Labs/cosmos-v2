import { z } from "zod";
import { IsoDateTime, NullableDateTime, NullableUuid, Uuid } from "./common";
import * as E from "./enums.generated";

export const KeyResult = z.object({
  id: Uuid,
  objectiveId: Uuid,
  title: z.string(),
  description: z.string().nullable(),
  startValue: z.number(),
  currentValue: z.number(),
  targetValue: z.number(),
  unit: z.string(),
  lowerIsBetter: z.boolean(),
  status: z.enum(E.KeyResultStatus),
  ownerId: NullableUuid,
  sortOrder: z.number().int(),
  confidence: z.number().int().nullable().describe("0–100, from the latest check-in."),
  rag: z.enum(E.RagStatus).nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).meta({ id: "KeyResult" });

export const Objective = z.object({
  id: Uuid,
  orgId: Uuid,
  projectId: Uuid,
  title: z.string(),
  description: z.string().nullable(),
  ownerId: NullableUuid,
  period: z.string().nullable(),
  status: z.enum(E.ObjectiveStatus),
  progress: z.number().int().describe("0–100."),
  targetDate: NullableDateTime,
  sortOrder: z.number().int(),
  parentId: NullableUuid.describe("The objective this one aligns to."),
  intervalId: NullableUuid,
  committed: z.boolean().describe("Committed vs stretch (uncommitted)."),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  keyResults: z.array(KeyResult),
}).meta({ id: "Objective" });

const LinkedItem = z.object({
  id: Uuid,
  ticketNumber: z.number().int(),
  title: z.string(),
  columnKey: z.string(),
  completedAt: NullableDateTime,
});

const Tracking = {
  autoTracked: z.boolean().describe("Progress is derived from linked work items rather than typed in."),
  linkedTotal: z.number().int(),
  linkedDone: z.number().int(),
};

const ObjectiveHealth = z.enum(["done", "on_track", "at_risk", "behind", "no_date"]);
const Overdue = z.boolean().describe("Past the end of its target day, and neither completed nor cancelled.");

/** "This objective needs that one first." May cross projects, never orgs. */
export const ObjectiveDependency = z.object({
  id: Uuid,
  orgId: Uuid,
  objectiveId: Uuid.describe("The objective that waits."),
  dependsOnId: Uuid.describe("The objective it needs first."),
  createdAt: IsoDateTime,
}).meta({ id: "ObjectiveDependency" });

const DependsOn = z.object({
  id: Uuid,
  title: z.string(),
  projectId: Uuid,
  status: z.enum(E.ObjectiveStatus),
  targetDate: NullableDateTime,
  progress: z.number().int().describe("0–100."),
  health: ObjectiveHealth,
  overdue: Overdue,
}).meta({ id: "ObjectiveDependsOn", description: "An objective this one depends on. Only those in projects the caller can read OKRs in are listed." });

export const ObjectiveWithProgress = Objective.extend({
  keyResults: z.array(KeyResult.extend({
    ...Tracking,
    targetFromLinks: z.boolean()
      .describe("`targetValue` is the number of linked work items, because no target was set. A key result with linked items and the default target of 100 counts as not set."),
    linkedItems: z.array(LinkedItem),
  })),
  ...Tracking,
  linkedItems: z.array(LinkedItem.extend({ workItemTypeId: Uuid })),
  health: ObjectiveHealth
    .describe("Progress against the time elapsed toward `targetDate`."),
  overdue: Overdue,
  dependsOn: z.array(DependsOn),
}).meta({
  id: "ObjectiveWithProgress",
  description: "A key result with linked work items counts done items as its current value, and the linked items as its target unless one was set; the objective rolls up from its key results (or, with none, from its own linked items).",
});

export const KeyResultCheckin = z.object({
  id: Uuid,
  keyResultId: Uuid,
  value: z.number(),
  confidence: z.number().int(),
  rag: z.enum(E.RagStatus),
  note: z.string().nullable(),
  blockers: z.string().nullable(),
  checkedInById: NullableUuid,
  createdAt: IsoDateTime,
}).meta({ id: "KeyResultCheckin" });

/** For schemas.test: every entity names every column of its model. */
export const entities = {
  KeyResult: { schema: KeyResult, model: "KeyResult", omitted: {} },
  Objective: { schema: Objective, model: "Objective", omitted: {} },
  KeyResultCheckin: { schema: KeyResultCheckin, model: "KeyResultCheckin", omitted: {} },
  ObjectiveDependency: { schema: ObjectiveDependency, model: "ObjectiveDependency", omitted: {} },
};
