import { z } from "zod";
import { PROBLEM_CODES } from "../problem-codes";
import * as E from "./enums.generated";

/**
 * Shared component schemas: the wire shapes the published spec names (each
 * `.meta({ id })` becomes `#/components/schemas/<id>`), and the shapes MCP's
 * `outputSchema` will reuse. Response schemas strip, so a field missing here
 * is a field the API doesn't return. Add it deliberately.
 *
 * Pure zod: these are imported by contract files, which the spec build runs in
 * plain node. Enum values come from enums.generated.ts (generated from
 * schema.prisma), not @prisma/client, for the same reason.
 *
 * Every entity schema names every scalar column of its model, or withholds it
 * on purpose: `schemas.test.ts` checks this against Prisma's own model list.
 */

/** Any 8-4-4-4-12 hex id. Not RFC-strict `z.uuid()`: rows seeded or imported
 *  with non-v4 ids are real, and a response schema that refused them would
 *  turn a valid row into a 500. */
export const Uuid = z.guid().meta({ id: "Uuid", example: "0b8f6c1e-6a52-4bd0-9b0e-3a4c2f6d1e7a" });

/** Inline, not `Uuid.nullable()`: a nullable $ref renders as
 *  `allOf: [Uuid, string|null]`, which no `null` can satisfy. */
export const NullableUuid = z.guid().nullable();

/** Timestamps are ISO 8601 UTC strings on the wire. */
export const IsoDateTime = z.iso.datetime({ offset: true })
  .meta({ id: "IsoDateTime", example: "2026-11-01T09:30:00.000Z" });

export const Problem = z.object({
  type: z.string().describe("Relative URI of this code in the errors guide."),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  // An extensible enum: the set of codes grows as features add refusals of
  // their own, and a client must treat an unknown code by its `status`. As a
  // closed `enum`, every new code was a breaking change to every operation.
  code: z.string().meta({ "x-extensible-enum": Object.keys(PROBLEM_CODES) }),
  requestId: z.string().optional().describe("The `X-Request-Id` of the request. Quote it to support."),
  issues: z.array(z.unknown()).optional().describe("Validation failures, on 400 `invalid_request`."),
  error: z.string().describe("Deprecated: same text as `detail` (or `title`). Kept for existing clients."),
}).meta({ id: "Problem", description: "RFC 9457 problem details (`application/problem+json`)." });

export const NullableDateTime = z.iso.datetime({ offset: true }).nullable();
export const Json = z.unknown();
export const Count = (...keys: string[]) =>
  z.object(Object.fromEntries(keys.map((k) => [k, z.number().int()])));

/** A query/body date: `2026-11-01` or a full ISO datetime. */
export const DateOrDateTime = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

/**
 * A date FILTER in a query string: anything `Date.parse` reads, as these
 * routes took before they had contracts (`2026-11-01`, an offset-less
 * datetime, an RFC 2822 date). Query use only: bodies stay strict. A string
 * `Date.parse` can't read is a 400; it used to reach Prisma as Invalid Date.
 */
export const QueryDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "Not a date")
  .meta({ format: "date-time", example: "2026-11-01" });

/**
 * A query parameter given more than once (`?search=a&search=b`) reads as its
 * first value, as `searchParams.get()` did before these routes had contracts.
 * Documented as the inner schema.
 */
export const firstOf = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (Array.isArray(v) ? v[0] : v), schema);

/**
 * An id FILTER in a query string. Blank (`?assigneeId=`) means "no filter",
 * as these routes read it before they had contracts; anything else must be an
 * id (it used to reach Prisma and fail as a 500).
 */
export const QueryId = z
  .string()
  .refine((s) => s === "" || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s), "Not an id")
  .meta({ format: "uuid" });

/**
 * A query integer clamped into [min, max] rather than refused, as these routes
 * did before they had contracts: `?limit=1000` reads as the maximum. A value
 * that isn't a number at all is still a 400.
 */
export const clampedInt = (min: number, max: number, fallback: number) =>
  z.coerce
    .number()
    .default(fallback)
    .transform((n) => Math.min(max, Math.max(min, Math.trunc(n))))
    // Documented as what a client should send; the clamping is in the description.
    .meta({ type: "integer", default: fallback });

export const Project = z.object({
  id: Uuid,
  orgId: Uuid,
  name: z.string(),
  key: z.string().describe("Short uppercase key; ticket ids are `<key>-<number>`."),
  description: z.string().nullable(),
  status: z.enum(E.ProjectStatus),
  archived: z.boolean(),
  settings: z.record(z.string(), z.unknown()).describe("Board and display settings."),
  projectTemplateId: NullableUuid,
  enabledFeatures: z.array(z.string()).describe("Optional board tabs this project has switched on."),
  sector: z.string().nullable().describe("Sector of the template the project was created from."),
  teamScopedAccess: z.boolean().describe("Only project members (and org admins) can see it."),
  clientId: NullableUuid,
  externalRef: z.string().nullable(),
  krLinkTypeId: NullableUuid,
  objectiveLinkTypeId: NullableUuid,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  _count: z.object({ boards: z.number().int(), intervals: z.number().int(), members: z.number().int() }),
}).meta({ id: "Project" });

/** A project as create/update return it: no flattened `sector`. */
const ProjectRow = Project.omit({ sector: true });

export const BoardColumn = z.object({
  id: Uuid,
  boardId: Uuid,
  name: z.string(),
  key: z.string().describe("Stable key work items reference as their `columnKey`."),
  color: z.string(),
  wipLimit: z.number().int().nullable(),
  sortOrder: z.number().int(),
  category: z.enum(E.ColumnCategory),
  statusKeys: z.array(z.string()).describe("The statuses this column shows. Empty means the status whose key is `key`."),
}).meta({ id: "BoardColumn" });

export const Board = z.object({
  id: Uuid,
  orgId: Uuid,
  projectId: Uuid,
  teamId: NullableUuid,
  name: z.string(),
  slug: z.string().nullable(),
  type: z.enum(E.BoardType),
  config: z.record(z.string(), z.unknown()),
  sortOrder: z.number().int(),
  createdAt: IsoDateTime,
  columns: z.array(BoardColumn),
}).meta({ id: "Board" });

export const Interval = z.object({
  id: Uuid,
  orgId: Uuid,
  projectId: Uuid,
  intervalKind: z.enum(E.IntervalKind).describe("Sprint, phase, Program Increment, …"),
  number: z.number().int().describe("Sequence within the project."),
  name: z.string(),
  sectorLabel: z.string().nullable(),
  goal: z.string(),
  startDate: IsoDateTime,
  endDate: IsoDateTime,
  status: z.enum(E.SprintStatus),
  report: Json.describe("Completion report, set when the interval is completed."),
  createdAt: IsoDateTime,
  parentId: NullableUuid.describe("The Program Increment this interval sits in."),
}).meta({ id: "Interval" });

export const IntervalWithCount = Interval.extend({ _count: Count("workItems") }).meta({ id: "IntervalSummary" });

/** Who someone is, as other records show them. `email` reaches signed-in browser sessions only. */
export const UserSummary = z.object({
  id: Uuid,
  email: z.string().optional().describe("Returned to browser sessions, and to API tokens that hold `members:read`."),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
}).meta({ id: "UserSummary" });

export const ProjectMember = z.object({
  id: Uuid,
  projectId: Uuid,
  orgMemberId: Uuid,
  role: z.enum(E.ProjectRole),
  allocationPercent: z.number().int().nullable(),
  onContract: z.boolean(),
  cacStatus: z.string().nullable(),
  cacExpiry: NullableDateTime,
  trainingStatus: z.string().nullable(),
  accessStatus: z.string().nullable(),
  ndaStatus: z.string().nullable(),
  complianceNotes: z.string().nullable(),
  orgMember: z.object({ id: Uuid, role: z.enum(E.OrgRole), user: UserSummary }),
}).meta({ id: "ProjectMember" });

export const ProjectWithBoards = ProjectRow.extend({ boards: z.array(Board) }).meta({ id: "ProjectWithBoards" });

export const ProjectDetail = ProjectRow.extend({
  boards: z.array(Board),
  intervals: z.array(Interval),
  members: z.array(ProjectMember),
}).meta({ id: "ProjectDetail" });

export const UpdatedProject = ProjectRow.meta({ id: "ProjectUpdate" });

export const WorkItem = z.object({
  id: Uuid,
  orgId: Uuid,
  projectId: Uuid,
  title: z.string().describe("User-authored text."),
  description: z.string().describe("User-authored text (rich text as markdown)."),
  columnKey: z.string().describe("The board column (status) it sits in."),
  assigneeId: NullableUuid,
  priority: z.enum(E.Priority),
  parentId: NullableUuid,
  ticketNumber: z.number().int().describe("`<project key>-<ticketNumber>`."),
  storyPoints: z.number().int().nullable(),
  sortOrder: z.number().int(),
  dueDate: NullableDateTime,
  startDate: NullableDateTime,
  actualStart: NullableDateTime,
  completedAt: NullableDateTime,
  columnEnteredAt: NullableDateTime,
  workCategory: z.enum(E.WorkCategory),
  archivedAt: NullableDateTime,
  cancelReason: z.enum(E.CancelReason).nullable(),
  cancelNote: z.string().nullable(),
  mergedIntoId: NullableUuid,
  tags: z.array(z.string()),
  highlight: z.string().nullable(),
  customFields: z.record(z.string(), z.unknown()),
  createdById: Uuid,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  workItemTypeId: Uuid,
  intervalId: NullableUuid,
  teamId: NullableUuid,
  externalSource: z.string().nullable(),
  externalId: z.string().nullable(),
  externalKey: z.string().nullable(),
  sourceStatus: z.string().nullable(),
  resolution: z.string().nullable(),
  originalEstimate: z.number().int().nullable(),
  remainingEstimate: z.number().int().nullable(),
  timeSpent: z.number().int().nullable(),
  sourceRecord: Json.describe("The record an import or sync created this item from, as the source system sent it; null otherwise."),
}).meta({ id: "WorkItem" });

export const IntervalDetail = IntervalWithCount.extend({
  workItems: z.array(WorkItem.extend({ _count: Count("comments") })),
}).meta({ id: "IntervalDetail" });

export const MilestoneLink = z.object({
  id: Uuid,
  milestoneId: Uuid,
  workItemId: Uuid,
  createdAt: IsoDateTime,
}).meta({ id: "MilestoneLink" });

export const Milestone = z.object({
  id: Uuid,
  orgId: Uuid,
  projectId: Uuid,
  title: z.string(),
  description: z.string().nullable(),
  dueDate: IsoDateTime,
  status: z.enum(E.MilestoneStatus),
  autoStatus: z.boolean().describe("Status and date follow the linked work items."),
  completedAt: NullableDateTime,
  ownerId: NullableUuid,
  sortOrder: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  intervalId: NullableUuid,
  actualDate: NullableDateTime,
  rootCause: z.string().nullable(),
  recoveryPlan: z.string().nullable(),
  recoveryTarget: NullableDateTime,
  scheduleEscalate: z.boolean(),
  downstreamImpact: z.string().nullable(),
  notes: z.string().nullable(),
  links: z.array(MilestoneLink),
}).meta({ id: "Milestone" });

export const MilestoneWithProgress = Milestone.extend({
  interval: z.object({ id: Uuid, number: z.number().int(), name: z.string(), startDate: IsoDateTime, endDate: IsoDateTime })
    .nullable(),
  linkedTotal: z.number().int().describe("Linked work items that still exist."),
  linkedDone: z.number().int(),
  completionPercent: z.number().nullable().describe("Share of linked items done; null with no links."),
}).meta({
  id: "MilestoneWithProgress",
  description: "With `autoStatus`, `status`, `dueDate` and `completedAt` are derived from the linked items on read.",
});

export const Member = z.object({
  id: Uuid,
  orgId: Uuid,
  userId: Uuid,
  role: z.enum(E.OrgRole),
  joinedAt: IsoDateTime,
  user: UserSummary.extend({ lastActiveAt: NullableDateTime }),
}).meta({ id: "Member" });

export const Label = z.object({
  id: Uuid,
  orgId: Uuid,
  name: z.string(),
  color: z.string().nullable(),
  createdAt: IsoDateTime,
  itemCount: z.number().int().describe("Work items carrying it (in `projectId`, when given)."),
}).meta({ id: "Label" });

export const WorkItemType = z.object({
  id: Uuid,
  orgId: NullableUuid.describe("Null for built-in types shared by every organization."),
  projectTemplateId: NullableUuid,
  key: z.string(),
  name: z.string(),
  pluralName: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  isBuiltIn: z.boolean(),
  sortOrder: z.number().int(),
  defaultParentTypeKey: z.string().nullable(),
  celebrateOnComplete: z.boolean(),
  createdAt: IsoDateTime,
}).meta({ id: "WorkItemType" });

export const CustomField = z.object({
  id: Uuid,
  orgId: Uuid,
  projectId: NullableUuid.describe("Null for an org-wide field."),
  name: z.string(),
  key: z.string(),
  fieldType: z.enum(E.FieldType),
  options: Json.describe("Choices for SELECT / MULTI_SELECT."),
  required: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: IsoDateTime,
  typeBindings: z.array(z.object({
    id: Uuid, workItemTypeId: Uuid, customFieldId: Uuid, required: z.boolean(), sortOrder: z.number().int(),
  })).describe("Work-item types it applies to; empty means every type."),
}).meta({ id: "CustomField" });

/** What a DELETE that answers with a body returns. */
export const DeletedRef = z.object({ id: Uuid }).meta({ id: "DeletedRef" });
