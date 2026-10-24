import { z } from "zod";
import { IsoDateTime, NullableDateTime, NullableUuid, Uuid } from "./common";
import * as E from "./enums.generated";

export const GoalLink = z.object({
  id: Uuid,
  goalId: Uuid,
  kind: z.enum(E.GoalLinkKind),
  workItemId: NullableUuid,
  objectiveId: NullableUuid,
  createdAt: IsoDateTime,
}).meta({ id: "GoalLink" });

export const Goal = z.object({
  id: Uuid,
  orgId: Uuid,
  projectId: Uuid,
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(E.GoalStatus),
  progress: z.number().int().describe("0–100. With `progressMode: AUTO`, rolled up from the links on read."),
  progressMode: z.enum(E.GoalProgressMode),
  targetDate: NullableDateTime,
  ownerId: NullableUuid,
  sortOrder: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  links: z.array(GoalLink),
}).meta({ id: "Goal" });

export const KpiDataPoint = z.object({
  id: Uuid,
  kpiId: Uuid,
  value: z.number(),
  recordedAt: IsoDateTime,
  note: z.string().nullable(),
  createdAt: IsoDateTime,
}).meta({ id: "KpiDataPoint" });

export const Kpi = z.object({
  id: Uuid,
  orgId: Uuid,
  projectId: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  unit: z.string(),
  targetValue: z.number(),
  currentValue: z.number(),
  direction: z.enum(E.KpiDirection),
  autoSource: z.enum(E.KpiAutoSource).describe("`MANUAL`, or the delivery metric the value is computed from."),
  autoWindowDays: z.number().int().nullable(),
  sortOrder: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  dataPoints: z.array(KpiDataPoint),
}).meta({ id: "Kpi" });

export const KpiWithSource = Kpi.extend({
  derived: z.boolean().describe("`currentValue` was computed from `autoSource` on read."),
}).meta({ id: "KpiWithSource" });

export const entities = {
  GoalLink: { schema: GoalLink, model: "GoalLink", omitted: {} },
  Goal: { schema: Goal, model: "Goal", omitted: {} },
  KpiDataPoint: { schema: KpiDataPoint, model: "KpiDataPoint", omitted: {} },
  Kpi: { schema: Kpi, model: "Kpi", omitted: {} },
};
