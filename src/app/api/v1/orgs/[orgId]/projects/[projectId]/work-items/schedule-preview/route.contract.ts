import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { NullableDateTime, Uuid } from "@/lib/openapi/schemas/common";

const Range = z.object({ startDate: NullableDateTime, dueDate: NullableDateTime });
const Change = z.object({ itemId: Uuid, before: Range, after: Range });

const Section = z.object({
  key: z.string(),
  title: z.string(),
  rows: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      before: z.string().optional(),
      after: z.string().optional(),
      delta: z.string().optional(),
      tone: z.enum(["neutral", "positive", "warn", "critical"]),
    }),
  ),
  prompt: z
    .object({ message: z.string(), action: z.object({ label: z.string(), href: z.string() }).optional() })
    .optional(),
});

export const previewSchedule = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/schedule-preview",
  operationId: "previewSchedule",
  summary: "Preview a reschedule",
  description:
    "What moving these items to these dates WOULD do, without saving anything: every item that moves " +
    "(the cascade included: parents widened, successors shifted), each assignee's load before and after, " +
    "and any sections enabled plugins add (fees, rates, hours). Needs ITEM_UPDATE on every item, as the " +
    "save would; a key needs items:write, the scope that could make the save.",
  tags: ["Work items"],
  stability: "internal",
  scopes: ["items:write"],
  request: {
    params: z.object({ orgId: Uuid, projectId: Uuid }),
    body: z.object({
      changes: z
        .array(z.object({ id: Uuid, startDate: NullableDateTime, dueDate: NullableDateTime }))
        .min(1)
        .max(50)
        .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, "each item at most once"),
    }),
  },
  responses: {
    200: z.object({
      changes: z.array(Change),
      cascaded: z.array(Change.extend({ reason: z.enum(["successor-shift", "parent-envelope"]) })),
      allocation: z.array(
        z.object({
          userId: Uuid,
          name: z.string(),
          weeklyCapacityHours: z.number().nullable(),
          peakBefore: z.number().int(),
          peakAfter: z.number().int(),
          pointsBefore: z.number(),
          pointsAfter: z.number(),
        }),
      ),
      sections: z.array(Section),
      needsConfirm: z.boolean(),
    }),
  },
  errors: [400, 401, 403, 404],
});
