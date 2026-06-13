import { prisma } from "@/lib/db/client";
import { storeEmbedding } from "@/lib/rag/embed";
import { roadmapSlug } from "@/lib/roadmap/import";

/** The item kinds a single document block can be converted into. */
export type ConvertItemType =
  | "ISSUE"
  | "MILESTONE"
  | "OBJECTIVE"
  | "GOAL"
  | "CYCLE"
  | "ROADMAP_NODE";

/** A block's text, scoped to org + project (shared by the single-block creators). */
async function loadBlockText(orgId: string, projectId: string, blockId: string) {
  const block = await prisma.documentBlock.findFirst({
    where: { id: blockId, orgId, document: { projectId } },
    select: { id: true, text: true },
  });
  if (!block) throw new Error("Block not found");
  return block;
}

/**
 * Resolve the default work-item type (the project sector's built-in `*.task`)
 * + a column for new items. The sector comes from the project's template
 * (`projectTemplate.sector`, default "software"); we look up the matching
 * `${sector}.task` built-in and fall back to ANY built-in `*.task` if the
 * sector-specific one is missing — mirroring the canonical work-items POST
 * route so a non-software-sector project gets its own task type.
 */
export async function resolveTypeAndColumn(projectId: string, columnKey?: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { projectTemplateId: true },
  });
  let sector = "software";
  if (project?.projectTemplateId) {
    const tpl = await prisma.projectTemplate.findUnique({
      where: { id: project.projectTemplateId },
      select: { sector: true },
    });
    if (tpl?.sector) sector = tpl.sector;
  }
  let typeRow = await prisma.workItemType.findFirst({
    where: { isBuiltIn: true, key: `${sector}.task` },
    select: { id: true },
  });
  if (!typeRow) {
    typeRow = await prisma.workItemType.findFirst({
      where: { isBuiltIn: true, key: { endsWith: ".task" } },
      orderBy: { key: "asc" },
      select: { id: true },
    });
  }
  if (!typeRow) throw new Error("No built-in task type available");
  let resolvedColumn = columnKey;
  if (!resolvedColumn) {
    const col = await prisma.boardColumn.findFirst({
      where: { board: { projectId } },
      orderBy: { sortOrder: "asc" },
      select: { key: true },
    });
    resolvedColumn = col?.key ?? "backlog";
  }
  return { typeId: typeRow.id, columnKey: resolvedColumn };
}

/**
 * Convert a DocumentBlock into a project Work Item (Issue) and link them.
 * The item carries the block's text as its description and a `from-document` tag.
 */
export async function convertBlockToWorkItem(input: {
  orgId: string;
  projectId: string;
  blockId: string;
  userId: string;
  title?: string;
  columnKey?: string;
}) {
  const block = await prisma.documentBlock.findFirst({
    where: { id: input.blockId, orgId: input.orgId, document: { projectId: input.projectId } },
    select: { id: true, text: true },
  });
  if (!block) throw new Error("Block not found");

  const { typeId, columnKey } = await resolveTypeAndColumn(input.projectId, input.columnKey);
  const title = (input.title?.trim() || block.text.split("\n")[0] || "Untitled").slice(0, 500);
  const description = block.text.slice(0, 20_000);

  const result = await prisma.$transaction(async (tx) => {
    const maxTicket = await tx.workItem.aggregate({
      where: { orgId: input.orgId, projectId: input.projectId },
      _max: { ticketNumber: true },
    });
    const maxSort = await tx.workItem.aggregate({
      where: { orgId: input.orgId, projectId: input.projectId, columnKey },
      _max: { sortOrder: true },
    });
    const item = await tx.workItem.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        workItemTypeId: typeId,
        title,
        description,
        columnKey,
        priority: "MEDIUM",
        ticketNumber: (maxTicket._max.ticketNumber ?? 0) + 1,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
        columnEnteredAt: new Date(),
        tags: ["from-document"],
        createdById: input.userId,
      },
      select: { id: true, title: true, ticketNumber: true, columnKey: true },
    });
    await tx.activity.create({
      data: { orgId: input.orgId, workItemId: item.id, userId: input.userId, action: "created" },
    });
    const link = await tx.documentItemLink.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        blockId: block.id,
        itemType: "WORK_ITEM",
        itemId: item.id,
      },
      select: { id: true, blockId: true, itemType: true, itemId: true },
    });
    return { item, link };
  });

  await storeEmbedding("work_items", result.item.id, `${title}\n${description}`).catch(() => {});
  return result;
}

/**
 * Convert a DocumentBlock into a Milestone (+ link). `dueDate` defaults to 30 days
 * out (the Milestone view lets the user adjust it); the block text becomes the
 * milestone description.
 */
export async function convertBlockToMilestone(input: {
  orgId: string;
  projectId: string;
  blockId: string;
  userId: string;
  title?: string;
  dueDate?: string;
}) {
  const block = await prisma.documentBlock.findFirst({
    where: { id: input.blockId, orgId: input.orgId, document: { projectId: input.projectId } },
    select: { id: true, text: true },
  });
  if (!block) throw new Error("Block not found");

  const title = (input.title?.trim() || block.text.split("\n")[0] || "Untitled milestone").slice(0, 200);
  const parsed = input.dueDate ? new Date(input.dueDate) : null;
  const dueDate = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(Date.now() + 30 * 86_400_000);

  return prisma.$transaction(async (tx) => {
    const maxSort = await tx.milestone.aggregate({
      where: { orgId: input.orgId, projectId: input.projectId },
      _max: { sortOrder: true },
    });
    const milestone = await tx.milestone.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        title,
        description: block.text.slice(0, 20_000) || null,
        dueDate,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
      select: { id: true, title: true, dueDate: true },
    });
    const link = await tx.documentItemLink.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        blockId: block.id,
        itemType: "MILESTONE",
        itemId: milestone.id,
      },
      select: { id: true, blockId: true, itemType: true, itemId: true },
    });
    return { milestone, link };
  });
}

/**
 * Convert a TABLE block into many Work Items — one per data row — using a chosen
 * title column (CSV-style mapping). Each item links back to the source block.
 * `headerRow` drops row 0; `titleColumn` is the 0-based column index for the title.
 */
export async function convertTableToWorkItems(input: {
  orgId: string;
  projectId: string;
  blockId: string;
  userId: string;
  titleColumn: number;
  headerRow: boolean;
  columnKey?: string;
}): Promise<{ count: number }> {
  const block = await prisma.documentBlock.findFirst({
    where: { id: input.blockId, orgId: input.orgId, document: { projectId: input.projectId } },
    select: { id: true, kind: true, data: true },
  });
  if (!block || block.kind !== "TABLE") throw new Error("Not a table block");

  const rows = ((block.data as { rows?: string[][] } | null)?.rows ?? []) as string[][];
  const header = input.headerRow ? rows[0] : undefined;
  const dataRows = input.headerRow ? rows.slice(1) : rows;
  // Each created item's title = the title-column cell; remaining columns become a
  // "Col: value" description so no data is lost.
  const records = dataRows
    .map((r) => ({
      title: (r[input.titleColumn] ?? "").trim(),
      description: r
        .map((cell, i) =>
          i === input.titleColumn ? null : `**${header?.[i] ?? `Column ${i + 1}`}:** ${cell}`,
        )
        .filter((x): x is string => !!x && !x.endsWith(":** "))
        .join("\n"),
    }))
    .filter((rec) => rec.title);
  if (!records.length) return { count: 0 };

  const { typeId, columnKey } = await resolveTypeAndColumn(input.projectId, input.columnKey);

  await prisma.$transaction(async (tx) => {
    const maxTicket = await tx.workItem.aggregate({
      where: { orgId: input.orgId, projectId: input.projectId },
      _max: { ticketNumber: true },
    });
    const maxSort = await tx.workItem.aggregate({
      where: { orgId: input.orgId, projectId: input.projectId, columnKey },
      _max: { sortOrder: true },
    });
    let ticket = maxTicket._max.ticketNumber ?? 0;
    let sort = maxSort._max.sortOrder ?? -1;
    for (const rec of records) {
      const item = await tx.workItem.create({
        data: {
          orgId: input.orgId,
          projectId: input.projectId,
          workItemTypeId: typeId,
          title: rec.title.slice(0, 500),
          description: rec.description.slice(0, 20_000),
          columnKey,
          priority: "MEDIUM",
          ticketNumber: ++ticket,
          sortOrder: ++sort,
          columnEnteredAt: new Date(),
          tags: ["from-document"],
          createdById: input.userId,
        },
        select: { id: true },
      });
      await tx.activity.create({
        data: { orgId: input.orgId, workItemId: item.id, userId: input.userId, action: "created" },
      });
      await tx.documentItemLink.create({
        data: {
          orgId: input.orgId,
          projectId: input.projectId,
          blockId: block.id,
          itemType: "WORK_ITEM",
          itemId: item.id,
        },
      });
    }
  });

  return { count: records.length };
}

/**
 * Convert a DocumentBlock into an OKR Objective (+ link). The first text line
 * becomes the title; the full block text becomes the description.
 */
export async function convertBlockToObjective(input: {
  orgId: string;
  projectId: string;
  blockId: string;
  userId: string;
  title?: string;
}) {
  const block = await loadBlockText(input.orgId, input.projectId, input.blockId);
  const title = (input.title?.trim() || block.text.split("\n")[0] || "Untitled objective").slice(0, 500);

  return prisma.$transaction(async (tx) => {
    const objective = await tx.objective.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        title,
        description: block.text.slice(0, 20_000) || null,
      },
      select: { id: true, title: true },
    });
    const link = await tx.documentItemLink.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        blockId: block.id,
        itemType: "OBJECTIVE",
        itemId: objective.id,
      },
      select: { id: true, blockId: true, itemType: true, itemId: true },
    });
    return { objective, link };
  });
}

/**
 * Convert a DocumentBlock into a delivery Goal (+ link). Status defaults to
 * PLANNED with MANUAL progress; the block text becomes the description.
 */
export async function convertBlockToGoal(input: {
  orgId: string;
  projectId: string;
  blockId: string;
  userId: string;
  title?: string;
}) {
  const block = await loadBlockText(input.orgId, input.projectId, input.blockId);
  const title = (input.title?.trim() || block.text.split("\n")[0] || "Untitled goal").slice(0, 500);

  return prisma.$transaction(async (tx) => {
    const maxSort = await tx.goal.aggregate({
      where: { orgId: input.orgId, projectId: input.projectId },
      _max: { sortOrder: true },
    });
    const goal = await tx.goal.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        title,
        description: block.text.slice(0, 20_000) || null,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
      select: { id: true, title: true },
    });
    const link = await tx.documentItemLink.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        blockId: block.id,
        itemType: "GOAL",
        itemId: goal.id,
      },
      select: { id: true, blockId: true, itemType: true, itemId: true },
    });
    return { goal, link };
  });
}

/**
 * Convert a DocumentBlock into a Sprint/Cycle (+ link). `number` is the next per
 * project, dates default to a two-week window from now, and the block text seeds
 * the sprint goal. The Scrum view lets the user adjust dates afterward.
 */
export async function convertBlockToCycle(input: {
  orgId: string;
  projectId: string;
  blockId: string;
  userId: string;
  title?: string;
}) {
  const block = await loadBlockText(input.orgId, input.projectId, input.blockId);
  const name = (input.title?.trim() || block.text.split("\n")[0] || "Untitled sprint").slice(0, 200);
  const startDate = new Date();
  const endDate = new Date(Date.now() + 14 * 86_400_000);

  return prisma.$transaction(async (tx) => {
    const maxNum = await tx.cycle.aggregate({
      where: { orgId: input.orgId, projectId: input.projectId },
      _max: { number: true },
    });
    const cycle = await tx.cycle.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        number: (maxNum._max.number ?? 0) + 1,
        name,
        goal: block.text.slice(0, 2_000),
        startDate,
        endDate,
      },
      select: { id: true, name: true, number: true },
    });
    const link = await tx.documentItemLink.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        blockId: block.id,
        itemType: "CYCLE",
        itemId: cycle.id,
      },
      select: { id: true, blockId: true, itemType: true, itemId: true },
    });
    return { cycle, link };
  });
}

/**
 * Convert a DocumentBlock into a Roadmap SECTION node (+ link). The anchor is a
 * slug of the title, de-duplicated per project (`-2`, `-3`, …) to satisfy the
 * unique-anchor constraint; the block text becomes the node body.
 */
export async function convertBlockToRoadmapNode(input: {
  orgId: string;
  projectId: string;
  blockId: string;
  userId: string;
  title?: string;
}) {
  const block = await loadBlockText(input.orgId, input.projectId, input.blockId);
  const title = (input.title?.trim() || block.text.split("\n")[0] || "Untitled section").slice(0, 500);
  const base = roadmapSlug(title) || "section";

  return prisma.$transaction(async (tx) => {
    // Pick a per-project-unique anchor: base, then base-2, base-3, …
    const existing = await tx.roadmapNode.findMany({
      where: { orgId: input.orgId, projectId: input.projectId, anchor: { startsWith: base } },
      select: { anchor: true },
    });
    const taken = new Set(existing.map((n) => n.anchor));
    let anchor = base;
    for (let n = 2; taken.has(anchor); n++) anchor = `${base}-${n}`;

    const maxSort = await tx.roadmapNode.aggregate({
      where: { orgId: input.orgId, projectId: input.projectId },
      _max: { sortOrder: true },
    });
    const node = await tx.roadmapNode.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        kind: "SECTION",
        title,
        body: block.text.slice(0, 20_000),
        anchor,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
      select: { id: true, title: true, anchor: true },
    });
    const link = await tx.documentItemLink.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        blockId: block.id,
        itemType: "ROADMAP_NODE",
        itemId: node.id,
      },
      select: { id: true, blockId: true, itemType: true, itemId: true },
    });
    return { node, link };
  });
}

/** A normalized result so callers can handle every convert kind uniformly. */
export interface ConvertResult {
  itemType: ConvertItemType;
  id: string;
  title: string;
  /** Present only for ISSUE (the work-item ticket number). */
  ticketNumber: number | null;
}

/**
 * Convert a single document block into the requested item kind and return a
 * normalized `{ itemType, id, title, ticketNumber }`. Dispatches to the
 * per-kind creators above (each persists the item + a source link in one tx).
 */
export async function convertBlockToItem(input: {
  orgId: string;
  projectId: string;
  blockId: string;
  userId: string;
  itemType: ConvertItemType;
  title?: string;
  columnKey?: string;
}): Promise<ConvertResult> {
  switch (input.itemType) {
    case "MILESTONE": {
      const { milestone } = await convertBlockToMilestone(input);
      return { itemType: "MILESTONE", id: milestone.id, title: milestone.title, ticketNumber: null };
    }
    case "OBJECTIVE": {
      const { objective } = await convertBlockToObjective(input);
      return { itemType: "OBJECTIVE", id: objective.id, title: objective.title, ticketNumber: null };
    }
    case "GOAL": {
      const { goal } = await convertBlockToGoal(input);
      return { itemType: "GOAL", id: goal.id, title: goal.title, ticketNumber: null };
    }
    case "CYCLE": {
      const { cycle } = await convertBlockToCycle(input);
      return { itemType: "CYCLE", id: cycle.id, title: cycle.name, ticketNumber: null };
    }
    case "ROADMAP_NODE": {
      const { node } = await convertBlockToRoadmapNode(input);
      return { itemType: "ROADMAP_NODE", id: node.id, title: node.title, ticketNumber: null };
    }
    case "ISSUE":
    default: {
      const { item } = await convertBlockToWorkItem(input);
      return { itemType: "ISSUE", id: item.id, title: item.title, ticketNumber: item.ticketNumber };
    }
  }
}
