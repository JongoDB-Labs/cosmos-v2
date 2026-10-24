import { z } from "zod";
import { IsoDateTime, NullableDateTime, NullableUuid, Uuid } from "./common";
import * as E from "./enums.generated";

export const TimeEntry = z.object({
  id: Uuid,
  orgId: Uuid,
  userId: Uuid,
  projectId: NullableUuid,
  workItemId: NullableUuid,
  date: IsoDateTime,
  hours: z.number(),
  rate: z.string().nullable()
    .describe("Decimal, as a string. Null unless it's your own entry or you hold finance read."),
  client: z.string().nullable(),
  description: z.string(),
  billableType: z.enum(E.BillableType),
  status: z.enum(E.TimeEntryStatus),
  approvedById: NullableUuid,
  approvedAt: NullableDateTime,
  billedHours: z.number().nullable(),
  billedById: NullableUuid,
  billedAt: NullableDateTime,
  tags: z.array(z.string()),
  payRunId: NullableUuid,
  clinId: NullableUuid,
  timesheetId: NullableUuid,
  voidedAt: NullableDateTime,
  voidedById: NullableUuid,
  voidReason: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).meta({ id: "TimeEntry" });

export const entities = {
  TimeEntry: { schema: TimeEntry, model: "TimeEntry", omitted: {} },
};
