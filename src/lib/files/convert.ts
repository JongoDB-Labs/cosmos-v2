import { prisma } from "@/lib/db/client";
import { storeEmbedding } from "@/lib/rag/embed";

/** Resolve the default work-item type (built-in *.task) + a column for new items. */
async function resolveTypeAndColumn(projectId: string, columnKey?: string) {
  const typeRow = await prisma.workItemType.findFirst({
    where: { isBuiltIn: true, key: { endsWith: ".task" } },
    orderBy: { key: "asc" },
    select: { id: true },
  });
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
