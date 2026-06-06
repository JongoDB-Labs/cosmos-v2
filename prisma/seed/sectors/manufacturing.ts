import type { PrismaClient } from "@prisma/client";

interface ManufacturingWorkItemType {
  key: string;
  name: string;
  pluralName: string;
  icon: string;
  color: string;
  sortOrder: number;
  celebrateOnComplete: boolean;
  defaultParentTypeKey?: string;
}

const MANUFACTURING_WORK_ITEM_TYPES: ManufacturingWorkItemType[] = [
  { key: "manufacturing.production_order", name: "Production Order", pluralName: "Production Orders", icon: "Factory", color: "#6366f1", sortOrder: 0, celebrateOnComplete: false },
  { key: "manufacturing.work_order", name: "Work Order", pluralName: "Work Orders", icon: "ClipboardList", color: "#3b82f6", sortOrder: 1, defaultParentTypeKey: "manufacturing.production_order", celebrateOnComplete: false },
  { key: "manufacturing.operation", name: "Operation", pluralName: "Operations", icon: "Cog", color: "#10b981", sortOrder: 2, defaultParentTypeKey: "manufacturing.work_order", celebrateOnComplete: false },
  { key: "manufacturing.step", name: "Step", pluralName: "Steps", icon: "ArrowRight", color: "#64748b", sortOrder: 3, defaultParentTypeKey: "manufacturing.operation", celebrateOnComplete: true },
  { key: "manufacturing.ncr", name: "NCR", pluralName: "NCRs", icon: "AlertTriangle", color: "#ef4444", sortOrder: 4, celebrateOnComplete: false },
  { key: "manufacturing.car", name: "CAR", pluralName: "CARs", icon: "FileWarning", color: "#f59e0b", sortOrder: 5, celebrateOnComplete: false },
  { key: "manufacturing.inspection_item", name: "Inspection Item", pluralName: "Inspection Items", icon: "Search", color: "#8b5cf6", sortOrder: 6, celebrateOnComplete: true },
];

const MANUFACTURING_BOARD_TEMPLATES = [
  {
    slug: "manufacturing.work-orders",
    name: "Work-Order Kanban",
    category: "tracking",
    boardType: "KANBAN",
    sortOrder: 0,
    columns: [
      { name: "Queued", key: "queued", color: "#94a3b8", category: "TODO" },
      { name: "In Setup", key: "in-setup", color: "#fbbf24", category: "IN_PROGRESS" },
      { name: "Running", key: "running", color: "#3b82f6", category: "IN_PROGRESS" },
      { name: "QC Hold", key: "qc-hold", color: "#ef4444", category: "IN_PROGRESS" },
      { name: "Complete", key: "complete", color: "#34d399", category: "DONE" },
    ],
  },
  {
    slug: "manufacturing.ncr-tracker",
    name: "Quality NCR Tracker",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 1,
    columns: [],
  },
  {
    slug: "manufacturing.downtime",
    name: "Downtime Calendar",
    category: "planning",
    boardType: "CALENDAR",
    sortOrder: 2,
    columns: [],
  },
  {
    slug: "manufacturing.bom",
    name: "BOM Table",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 3,
    columns: [],
  },
  {
    slug: "manufacturing.inspections",
    name: "Inspection Checklist",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 4,
    columns: [],
  },
];

const MANUFACTURING_PROJECT_TEMPLATE = {
  slug: "manufacturing",
  sector: "manufacturing",
  name: "Production Run",
  description: "Work orders, operations, quality control, and inspection tracking.",
  defaultConfig: {
    cycleKinds: ["RUN"],
    cycleNavLabel: "Runs",
    enabledFeatures: ["kpi", "risk", "decision"],
  },
};

export async function seedManufacturing(prisma: PrismaClient) {
  // 1. Work item types (orgId: null, projectTemplateId: null for built-ins)
  for (const t of MANUFACTURING_WORK_ITEM_TYPES) {
    const existing = await prisma.workItemType.findFirst({
      where: { orgId: null, key: t.key },
    });
    if (existing) {
      await prisma.workItemType.update({
        where: { id: existing.id },
        data: { name: t.name, pluralName: t.pluralName, icon: t.icon, color: t.color },
      });
    } else {
      await prisma.workItemType.create({
        data: {
          key: t.key,
          name: t.name,
          pluralName: t.pluralName ?? null,
          icon: t.icon,
          color: t.color,
          isBuiltIn: true,
          sortOrder: t.sortOrder,
          defaultParentTypeKey: t.defaultParentTypeKey ?? null,
          celebrateOnComplete: t.celebrateOnComplete,
        },
      });
    }
  }
  console.log(`  manufacturing: upserted ${MANUFACTURING_WORK_ITEM_TYPES.length} work item types`);

  // 2. Project template
  const existingPt = await prisma.projectTemplate.findFirst({
    where: { orgId: null, slug: MANUFACTURING_PROJECT_TEMPLATE.slug },
  });
  let projectTemplate: { id: string };
  if (existingPt) {
    projectTemplate = await prisma.projectTemplate.update({
      where: { id: existingPt.id },
      data: {
        name: MANUFACTURING_PROJECT_TEMPLATE.name,
        description: MANUFACTURING_PROJECT_TEMPLATE.description,
        sector: MANUFACTURING_PROJECT_TEMPLATE.sector,
        defaultConfig: MANUFACTURING_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  } else {
    projectTemplate = await prisma.projectTemplate.create({
      data: {
        slug: MANUFACTURING_PROJECT_TEMPLATE.slug,
        sector: MANUFACTURING_PROJECT_TEMPLATE.sector,
        name: MANUFACTURING_PROJECT_TEMPLATE.name,
        description: MANUFACTURING_PROJECT_TEMPLATE.description,
        defaultConfig: MANUFACTURING_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  }
  console.log(`  manufacturing: upserted project template (id=${projectTemplate.id})`);

  // 3. Board templates
  for (const bt of MANUFACTURING_BOARD_TEMPLATES) {
    const existingBt = await prisma.boardTemplate.findFirst({
      where: { orgId: null, slug: bt.slug },
    });
    const defaultConfig = bt.columns.length > 0 ? { columns: bt.columns } : {};
    if (existingBt) {
      await prisma.boardTemplate.update({
        where: { id: existingBt.id },
        data: {
          name: bt.name,
          category: bt.category,
          boardType: bt.boardType,
          sortOrder: bt.sortOrder,
          sector: "manufacturing",
          projectTemplateId: projectTemplate.id,
          isBuiltIn: true,
          isPublished: true,
          defaultConfig,
        },
      });
    } else {
      await prisma.boardTemplate.create({
        data: {
          slug: bt.slug,
          name: bt.name,
          category: bt.category,
          boardType: bt.boardType,
          sortOrder: bt.sortOrder,
          sector: "manufacturing",
          projectTemplateId: projectTemplate.id,
          isBuiltIn: true,
          isPublished: true,
          defaultConfig,
        },
      });
    }
  }
  console.log(`  manufacturing: upserted ${MANUFACTURING_BOARD_TEMPLATES.length} board templates`);
}
