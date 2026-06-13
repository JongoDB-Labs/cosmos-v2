import { prisma } from "@/lib/db/client";
import { storeEmbedding } from "@/lib/rag/embed";

/**
 * Convert a DocumentBlock into a project Work Item (Issue) and link them.
 * v1 supports WORK_ITEM (the dominant "turn this section into a task" case);
 * other target types (milestone/OKR/…) follow. The created item carries the
 * block's text as its description and a `from-document` tag; a DocumentItemLink
 * records the source block (soft item ref, hard block FK).
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

  const typeRow = await prisma.workItemType.findFirst({
    where: { isBuiltIn: true, key: { endsWith: ".task" } },
    orderBy: { key: "asc" },
    select: { id: true },
  });
  if (!typeRow) throw new Error("No built-in task type available");

  let columnKey = input.columnKey;
  if (!columnKey) {
    const col = await prisma.boardColumn.findFirst({
      where: { board: { projectId: input.projectId } },
      orderBy: { sortOrder: "asc" },
      select: { key: true },
    });
    columnKey = col?.key ?? "backlog";
  }

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
        workItemTypeId: typeRow.id,
        title,
        description,
        columnKey: columnKey!,
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

  // RAG embed-on-write (best-effort, after commit) — matches the work-items route.
  await storeEmbedding("work_items", result.item.id, `${title}\n${description}`).catch(() => {});

  return result;
}
