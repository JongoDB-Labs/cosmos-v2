import type { PrismaClient } from "@prisma/client";

interface AecWorkItemType {
  key: string;
  name: string;
  pluralName: string;
  icon: string;
  color: string;
  sortOrder: number;
  celebrateOnComplete: boolean;
  defaultParentTypeKey?: string;
}

const AEC_WORK_ITEM_TYPES: AecWorkItemType[] = [
  { key: "aec.phase", name: "Phase", pluralName: "Phases", icon: "Milestone", color: "#6366f1", sortOrder: 0, celebrateOnComplete: false },
  { key: "aec.submittal", name: "Submittal", pluralName: "Submittals", icon: "FileStack", color: "#3b82f6", sortOrder: 1, defaultParentTypeKey: "aec.phase", celebrateOnComplete: false },
  { key: "aec.rfi", name: "RFI", pluralName: "RFIs", icon: "FileQuestion", color: "#f59e0b", sortOrder: 2, defaultParentTypeKey: "aec.phase", celebrateOnComplete: false },
  { key: "aec.change_order", name: "Change Order", pluralName: "Change Orders", icon: "FileEdit", color: "#ef4444", sortOrder: 3, defaultParentTypeKey: "aec.phase", celebrateOnComplete: false },
  { key: "aec.asi", name: "ASI", pluralName: "ASIs", icon: "FilePlus", color: "#8b5cf6", sortOrder: 4, defaultParentTypeKey: "aec.phase", celebrateOnComplete: false },
  { key: "aec.ccd", name: "CCD", pluralName: "CCDs", icon: "FileWarning", color: "#a855f7", sortOrder: 5, defaultParentTypeKey: "aec.phase", celebrateOnComplete: false },
  { key: "aec.punch_item", name: "Punch Item", pluralName: "Punch Items", icon: "ListChecks", color: "#10b981", sortOrder: 6, defaultParentTypeKey: "aec.phase", celebrateOnComplete: true },
  { key: "aec.safety_incident", name: "Safety Incident", pluralName: "Safety Incidents", icon: "ShieldAlert", color: "#dc2626", sortOrder: 7, celebrateOnComplete: false },
  { key: "aec.cost_impact_item", name: "Cost Impact", pluralName: "Cost Impacts", icon: "DollarSign", color: "#ca8a04", sortOrder: 8, defaultParentTypeKey: "aec.change_order", celebrateOnComplete: false },
];

const AEC_BOARD_TEMPLATES = [
  {
    slug: "aec.phase-gantt",
    name: "Phase Gantt",
    category: "planning",
    boardType: "TIMELINE",
    sortOrder: 0,
    columns: [],
  },
  {
    slug: "aec.submittal-log",
    name: "Submittal Log",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 1,
    columns: [],
  },
  {
    slug: "aec.rfi-tracker",
    name: "RFI Tracker",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 2,
    columns: [],
  },
  {
    slug: "aec.change-orders",
    name: "Change Orders",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 3,
    columns: [],
  },
  {
    slug: "aec.daily-logs",
    name: "Daily Logs",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 4,
    columns: [],
  },
  {
    slug: "aec.punch-list",
    name: "Punch List",
    category: "tracking",
    boardType: "KANBAN",
    sortOrder: 5,
    columns: [
      { name: "Open", key: "open", color: "#ef4444", category: "TODO" },
      { name: "In Progress", key: "in-progress", color: "#fbbf24", category: "IN_PROGRESS" },
      { name: "Verified", key: "verified", color: "#34d399", category: "DONE" },
    ],
  },
  {
    slug: "aec.safety",
    name: "Safety Incidents",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 6,
    columns: [],
  },
];

const AEC_PROJECT_TEMPLATE = {
  slug: "aec",
  sector: "aec",
  name: "Construction Project",
  description: "Phase-gated construction with submittals, RFIs, change orders, and daily logs.",
  defaultConfig: {
    intervalKinds: ["PHASE"],
    cycleNavLabel: "Phases",
    enabledFeatures: ["milestone", "kpi", "risk", "decision", "meeting_note"],
  },
};

export async function seedAec(prisma: PrismaClient) {
  // 1. Work item types (orgId: null, projectTemplateId: null for built-ins)
  for (const t of AEC_WORK_ITEM_TYPES) {
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
  console.log(`  aec: upserted ${AEC_WORK_ITEM_TYPES.length} work item types`);

  // 2. Project template
  const existingPt = await prisma.projectTemplate.findFirst({
    where: { orgId: null, slug: AEC_PROJECT_TEMPLATE.slug },
  });
  let projectTemplate: { id: string };
  if (existingPt) {
    projectTemplate = await prisma.projectTemplate.update({
      where: { id: existingPt.id },
      data: {
        name: AEC_PROJECT_TEMPLATE.name,
        description: AEC_PROJECT_TEMPLATE.description,
        sector: AEC_PROJECT_TEMPLATE.sector,
        defaultConfig: AEC_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  } else {
    projectTemplate = await prisma.projectTemplate.create({
      data: {
        slug: AEC_PROJECT_TEMPLATE.slug,
        sector: AEC_PROJECT_TEMPLATE.sector,
        name: AEC_PROJECT_TEMPLATE.name,
        description: AEC_PROJECT_TEMPLATE.description,
        defaultConfig: AEC_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  }
  console.log(`  aec: upserted project template (id=${projectTemplate.id})`);

  // 3. Board templates
  for (const bt of AEC_BOARD_TEMPLATES) {
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
          sector: "aec",
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
          sector: "aec",
          projectTemplateId: projectTemplate.id,
          isBuiltIn: true,
          isPublished: true,
          defaultConfig,
        },
      });
    }
  }
  console.log(`  aec: upserted ${AEC_BOARD_TEMPLATES.length} board templates`);
}
