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

export const ObjectiveWithProgress = Objective.extend({
  keyResults: z.array(KeyResult.extend({ ...Tracking, linkedItems: z.array(LinkedItem) })),
  ...Tracking,
  linkedItems: z.array(LinkedItem.extend({ workItemTypeId: Uuid })),
  health: z.enum(["done", "on_track", "at_risk", "behind", "no_date"])
    .describe("Progress against the time elapsed toward `targetDate`."),
}).meta({
  id: "ObjectiveWithProgress",
  description: "A key result with linked work items counts done items as its current value; the objective rolls up from its key results (or, with none, from its own linked items).",
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
};
