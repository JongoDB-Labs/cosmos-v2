import { z } from "zod";
import {
  Priority,
  ObjectiveStatus,
  GoalStatus,
  GoalProgressMode,
  CycleKind,
} from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { storeEmbedding } from "@/lib/rag/embed";
import { resolveTypeAndColumn } from "@/lib/files/convert";
import { upsertRoadmapNodes } from "@/lib/roadmap/import";
import { roadmapImportNodeSchema } from "@/lib/roadmap/types";
import type { RoadmapImportReport } from "@/lib/roadmap/types";
import { NotFoundError } from "@/lib/rbac/check";

/**
 * Structured item-ingest contract (BYO-LLM).
 *
 * An external LLM converts a document into a flat `items[]` array — each item
 * tagged with its `type` — and POSTs it. COSMOS creates the corresponding row
 * for every supported item kind (ISSUE / MILESTONE / OBJECTIVE / GOAL / CYCLE /
 * ROADMAP_NODE), attributing the creation to the authenticated user. This
 * generalizes the roadmap-only ingest contract to every item type and reuses
 * the exact field/default logic the in-app converters apply.
 */

/** A parsed date (when present + valid) or undefined. */
function parseDate(value?: string | null): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const issueItemSchema = z.object({
  type: z.literal("ISSUE"),
  title: z.string().min(1).max(500),
  description: z.string().max(20_000).nullish(),
  columnKey: z.string().max(120).nullish(),
  priority: z.nativeEnum(Priority).nullish(),
  tags: z.array(z.string().max(60)).nullish(),
  dueDate: z.string().nullish(),
  startDate: z.string().nullish(),
});

const milestoneItemSchema = z.object({
  type: z.literal("MILESTONE"),
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).nullish(),
  dueDate: z.string().nullish(),
});

const objectiveItemSchema = z.object({
  type: z.literal("OBJECTIVE"),
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).nullish(),
  period: z.string().max(120).nullish(),
  status: z.nativeEnum(ObjectiveStatus).nullish(),
});

const goalItemSchema = z.object({
  type: z.literal("GOAL"),
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).nullish(),
  status: z.nativeEnum(GoalStatus).nullish(),
  targetDate: z.string().nullish(),
  progressMode: z.nativeEnum(GoalProgressMode).nullish(),
});

const cycleItemSchema = z.object({
  type: z.literal("CYCLE"),
  name: z.string().min(1).max(100),
  goal: z.string().max(2_000).nullish(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
  cycleKind: z.nativeEnum(CycleKind).nullish(),
});

const roadmapNodeItemSchema = roadmapImportNodeSchema.extend({
  type: z.literal("ROADMAP_NODE"),
});

export const itemSchema = z.discriminatedUnion("type", [
  issueItemSchema,
  milestoneItemSchema,
  objectiveItemSchema,
  goalItemSchema,
  cycleItemSchema,
  roadmapNodeItemSchema,
]);

export type ItemImport = z.infer<typeof itemSchema>;

export const itemImportSchema = z.object({
  mode: z.enum(["create"]).default("create"),
  items: z.array(itemSchema).min(1).max(500),
});

export type ItemImportRequest = z.infer<typeof itemImportSchema>;

export interface IngestItemsReport {
  mode: "create";
  created: Array<{
    type: ItemImport["type"];
    id: string;
    title: string;
    ticketNumber?: number;
  }>;
  roadmap?: RoadmapImportReport;
  warnings: string[];
}

type IssueItem = z.infer<typeof issueItemSchema>;
type MilestoneItem = z.infer<typeof milestoneItemSchema>;
type ObjectiveItem = z.infer<typeof objectiveItemSchema>;
type GoalItem = z.infer<typeof goalItemSchema>;
type CycleItem = z.infer<typeof cycleItemSchema>;

/**
 * Create one Work Item (Issue) + its `created` Activity row in a single tx,
 * mirroring convertBlockToWorkItem: next ticketNumber per org+project, next
 * sortOrder per column, MEDIUM priority default, columnEnteredAt = now,
 * attributed to `userId`. Embeds best-effort afterward.
 */
async function createIssue(
  orgId: string,
  projectId: string,
  userId: string,
  item: IssueItem,
): Promise<{ id: string; title: string; ticketNumber: number }> {
  const { typeId, columnKey } = await resolveTypeAndColumn(
    projectId,
    item.columnKey ?? undefined,
  );
  const title = item.title.slice(0, 500);
  const description = (item.description ?? "").slice(0, 20_000);
  const dueDate = parseDate(item.dueDate);
  const startDate = parseDate(item.startDate);

  const created = await prisma.$transaction(async (tx) => {
    const maxTicket = await tx.workItem.aggregate({
      where: { orgId, projectId },
      _max: { ticketNumber: true },
    });
    const maxSort = await tx.workItem.aggregate({
      where: { orgId, projectId, columnKey },
      _max: { sortOrder: true },
    });
    const wi = await tx.workItem.create({
      data: {
        orgId,
        projectId,
        workItemTypeId: typeId,
        title,
        description,
        columnKey,
        priority: item.priority ?? "MEDIUM",
        ticketNumber: (maxTicket._max.ticketNumber ?? 0) + 1,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
        columnEnteredAt: new Date(),
        tags: item.tags ?? [],
        dueDate: dueDate ?? null,
        startDate: startDate ?? null,
        createdById: userId,
      },
      select: { id: true, title: true, ticketNumber: true },
    });
    await tx.activity.create({
      data: { orgId, workItemId: wi.id, userId, action: "created" },
    });
    return wi;
  });

  await storeEmbedding("work_items", created.id, `${title}\n${description}`).catch(
    () => {},
  );
  return created;
}

/**
 * Create a Milestone — dueDate defaults to +30d, sortOrder = max+1,
 * autoStatus defaults true (schema default).
 */
async function createMilestone(
  orgId: string,
  projectId: string,
  item: MilestoneItem,
): Promise<{ id: string; title: string }> {
  const dueDate = parseDate(item.dueDate) ?? new Date(Date.now() + 30 * 86_400_000);
  return prisma.$transaction(async (tx) => {
    const maxSort = await tx.milestone.aggregate({
      where: { orgId, projectId },
      _max: { sortOrder: true },
    });
    return tx.milestone.create({
      data: {
        orgId,
        projectId,
        title: item.title,
        description: item.description ?? null,
        dueDate,
        autoStatus: true,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
      select: { id: true, title: true },
    });
  });
}

/** Create an Objective — status defaults ACTIVE, progress 0. */
async function createObjective(
  orgId: string,
  projectId: string,
  item: ObjectiveItem,
): Promise<{ id: string; title: string }> {
  return prisma.objective.create({
    data: {
      orgId,
      projectId,
      title: item.title,
      description: item.description ?? null,
      period: item.period ?? null,
      status: item.status ?? "ACTIVE",
      progress: 0,
    },
    select: { id: true, title: true },
  });
}

/** Create a Goal — status PLANNED, progressMode MANUAL, progress 0, sortOrder max+1. */
async function createGoal(
  orgId: string,
  projectId: string,
  item: GoalItem,
): Promise<{ id: string; title: string }> {
  const targetDate = parseDate(item.targetDate);
  return prisma.$transaction(async (tx) => {
    const maxSort = await tx.goal.aggregate({
      where: { orgId, projectId },
      _max: { sortOrder: true },
    });
    return tx.goal.create({
      data: {
        orgId,
        projectId,
        title: item.title,
        description: item.description ?? null,
        status: item.status ?? "PLANNED",
        progressMode: item.progressMode ?? "MANUAL",
        progress: 0,
        targetDate: targetDate ?? null,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
      select: { id: true, title: true },
    });
  });
}

/**
 * Create a Cycle (sprint) — number = max+1 per project, goal default "",
 * dates default to a two-week window from now, cycleKind default SPRINT.
 */
async function createCycle(
  orgId: string,
  projectId: string,
  item: CycleItem,
): Promise<{ id: string; name: string }> {
  const startDate = parseDate(item.startDate) ?? new Date();
  const endDate = parseDate(item.endDate) ?? new Date(Date.now() + 14 * 86_400_000);
  return prisma.$transaction(async (tx) => {
    const maxNum = await tx.cycle.aggregate({
      where: { orgId, projectId },
      _max: { number: true },
    });
    return tx.cycle.create({
      data: {
        orgId,
        projectId,
        number: (maxNum._max.number ?? 0) + 1,
        name: item.name,
        goal: item.goal ?? "",
        startDate,
        endDate,
        cycleKind: item.cycleKind ?? "SPRINT",
      },
      select: { id: true, name: true },
    });
  });
}

/**
 * Ingest a batch of structured items into a project, attributing every created
 * row to `userId`. Non-roadmap items create one row each (issues also write a
 * `created` Activity); all ROADMAP_NODE items are collected and upserted in a
 * single `upsertRoadmapNodes(..., "merge")` call so cross-references resolve.
 */
export async function ingestItems(input: {
  orgId: string;
  projectId: string;
  userId: string;
  items: ItemImport[];
  mode?: "create";
}): Promise<IngestItemsReport> {
  const { orgId, projectId, userId, items } = input;
  const mode = input.mode ?? "create";

  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    select: { id: true },
  });
  if (!project) throw new NotFoundError("Project not found");

  const report: IngestItemsReport = { mode, created: [], warnings: [] };
  const roadmapNodes: Array<z.infer<typeof roadmapNodeItemSchema>> = [];

  for (const item of items) {
    switch (item.type) {
      case "ISSUE": {
        const wi = await createIssue(orgId, projectId, userId, item);
        report.created.push({
          type: "ISSUE",
          id: wi.id,
          title: wi.title,
          ticketNumber: wi.ticketNumber,
        });
        break;
      }
      case "MILESTONE": {
        const m = await createMilestone(orgId, projectId, item);
        report.created.push({ type: "MILESTONE", id: m.id, title: m.title });
        break;
      }
      case "OBJECTIVE": {
        const o = await createObjective(orgId, projectId, item);
        report.created.push({ type: "OBJECTIVE", id: o.id, title: o.title });
        break;
      }
      case "GOAL": {
        const g = await createGoal(orgId, projectId, item);
        report.created.push({ type: "GOAL", id: g.id, title: g.title });
        break;
      }
      case "CYCLE": {
        const c = await createCycle(orgId, projectId, item);
        report.created.push({ type: "CYCLE", id: c.id, title: c.name });
        break;
      }
      case "ROADMAP_NODE": {
        roadmapNodes.push(item);
        break;
      }
    }
  }

  if (roadmapNodes.length) {
    // The roadmap node fields are exactly roadmapImportNodeSchema's plus the
    // discriminant `type`; strip `type` before handing them to the upserter.
    const nodes = roadmapNodes.map((item) => {
      const { type, ...node } = item;
      void type;
      return node;
    });
    report.roadmap = await upsertRoadmapNodes(prisma, orgId, projectId, nodes, "merge");
    report.warnings.push(...report.roadmap.warnings);
  }

  return report;
}
