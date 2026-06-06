import { Prisma, type BoardTemplateWidget } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { uniqueSlug, uniqueKey } from "./slugify";

type Tx = Prisma.TransactionClient;

type WidgetWithChildren = BoardTemplateWidget & {
  children?: WidgetWithChildren[];
};

export async function cloneProjectTemplate(
  sourceId: string,
  orgId: string,
  name: string,
): Promise<string> {
  const source = await prisma.projectTemplate.findUniqueOrThrow({
    where: { id: sourceId },
    include: {
      boardTemplates: { include: { widgets: true } },
      workItemTypes: true,
    },
  });

  const slug = await uniqueSlug("projectTemplate", name, orgId);

  return prisma.$transaction(async (tx) => {
    const clone = await tx.projectTemplate.create({
      data: {
        orgId,
        slug,
        sector: source.sector,
        name,
        description: source.description,
        isBuiltIn: false,
        defaultConfig: source.defaultConfig ?? {},
        sourceTemplateId: source.id,
      },
    });

    for (const wit of source.workItemTypes) {
      const key = await uniqueKey(wit.key, orgId);
      await tx.workItemType.create({
        data: {
          orgId,
          projectTemplateId: clone.id,
          key,
          name: wit.name,
          pluralName: wit.pluralName,
          icon: wit.icon,
          color: wit.color,
          sortOrder: wit.sortOrder,
          defaultParentTypeKey: wit.defaultParentTypeKey,
          celebrateOnComplete: wit.celebrateOnComplete,
        },
      });
    }

    for (const bt of source.boardTemplates) {
      const btSlug = await uniqueSlug("boardTemplate", bt.name, orgId);
      const boardClone = await tx.boardTemplate.create({
        data: {
          orgId,
          projectTemplateId: clone.id,
          slug: btSlug,
          name: bt.name,
          category: bt.category,
          boardType: bt.boardType,
          sector: bt.sector,
          methodology: bt.methodology,
          description: bt.description,
          sortOrder: bt.sortOrder,
          defaultConfig: bt.defaultConfig ?? {},
          sourceTemplateId: bt.id,
        },
      });

      for (const w of bt.widgets) {
        await cloneWidgetTree(tx, w, boardClone.id, null);
      }
    }

    return clone.id;
  });
}

export async function cloneBoardTemplate(
  sourceId: string,
  orgId: string,
  name: string,
): Promise<string> {
  const source = await prisma.boardTemplate.findUniqueOrThrow({
    where: { id: sourceId },
    include: { widgets: true },
  });

  const slug = await uniqueSlug("boardTemplate", name, orgId);

  return prisma.$transaction(async (tx) => {
    const clone = await tx.boardTemplate.create({
      data: {
        orgId,
        slug,
        name,
        category: source.category,
        boardType: source.boardType,
        sector: source.sector,
        methodology: source.methodology,
        description: source.description,
        sortOrder: source.sortOrder,
        defaultConfig: source.defaultConfig ?? {},
        projectTemplateId: source.projectTemplateId,
        sourceTemplateId: source.id,
        isBuiltIn: false,
      },
    });

    for (const w of source.widgets) {
      await cloneWidgetTree(tx, w, clone.id, null);
    }

    return clone.id;
  });
}

async function cloneWidgetTree(
  tx: Tx,
  source: WidgetWithChildren,
  templateId: string,
  parentId: string | null,
): Promise<void> {
  const clone = await tx.boardTemplateWidget.create({
    data: {
      templateId,
      widgetSlug: source.widgetSlug,
      parentWidgetId: parentId,
      config: source.config ?? {},
      layout: source.layout ?? {},
      sortOrder: source.sortOrder,
    },
  });

  if (source.children) {
    for (const child of source.children) {
      await cloneWidgetTree(tx, child, templateId, clone.id);
    }
  }
}
