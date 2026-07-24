import type { PrismaClient } from "@prisma/client";

interface ConsultingWorkItemType {
  key: string;
  name: string;
  pluralName: string;
  icon: string;
  color: string;
  sortOrder: number;
  celebrateOnComplete: boolean;
  defaultParentTypeKey?: string;
}

const CONSULTING_WORK_ITEM_TYPES: ConsultingWorkItemType[] = [
  { key: "consulting.engagement", name: "Engagement", pluralName: "Engagements", icon: "Handshake", color: "#6366f1", sortOrder: 0, celebrateOnComplete: false },
  { key: "consulting.workstream", name: "Workstream", pluralName: "Workstreams", icon: "GitBranch", color: "#3b82f6", sortOrder: 1, defaultParentTypeKey: "consulting.engagement", celebrateOnComplete: false },
  { key: "consulting.deliverable", name: "Deliverable", pluralName: "Deliverables", icon: "Package", color: "#10b981", sortOrder: 2, defaultParentTypeKey: "consulting.workstream", celebrateOnComplete: true },
  { key: "consulting.task", name: "Task", pluralName: "Tasks", icon: "CheckSquare", color: "#64748b", sortOrder: 3, defaultParentTypeKey: "consulting.deliverable", celebrateOnComplete: true },
  { key: "consulting.milestone_item", name: "Milestone", pluralName: "Milestones", icon: "Flag", color: "#f59e0b", sortOrder: 4, celebrateOnComplete: true },
];

const CONSULTING_BOARD_TEMPLATES = [
  {
    slug: "consulting.phases",
    name: "Engagement Phases",
    category: "planning",
    boardType: "TIMELINE",
    sortOrder: 0,
    columns: [],
  },
  {
    slug: "consulting.deliverables",
    name: "Deliverable Tracker",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 1,
    columns: [],
  },
  {
    slug: "consulting.timesheet",
    name: "Billable Timesheet",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 2,
    columns: [],
  },
  {
    slug: "consulting.checkpoints",
    name: "Checkpoint Calendar",
    category: "planning",
    boardType: "CALENDAR",
    sortOrder: 3,
    columns: [],
  },
  {
    slug: "consulting.closeout",
    name: "Closeout Checklist",
    category: "tracking",
    boardType: "KANBAN",
    sortOrder: 4,
    columns: [
      { name: "Pending", key: "pending", color: "#94a3b8", category: "TODO" },
      { name: "In Review", key: "in-review", color: "#fbbf24", category: "IN_PROGRESS" },
      { name: "Signed Off", key: "signed-off", color: "#34d399", category: "DONE" },
    ],
  },
];

const CONSULTING_PROJECT_TEMPLATE = {
  slug: "consulting",
  sector: "consulting",
  name: "Client Engagement",
  description: "Professional services with workstreams, deliverables, and milestone tracking.",
  defaultConfig: {
    intervalKinds: ["PHASE"],
    intervalNavLabel: "Phases",
    enabledFeatures: ["goal", "milestone", "kpi", "risk", "decision", "meeting_note"],
  },
};

export async function seedConsulting(prisma: PrismaClient) {
  // 1. Work item types (orgId: null, projectTemplateId: null for built-ins)
  for (const t of CONSULTING_WORK_ITEM_TYPES) {
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
  console.log(`  consulting: upserted ${CONSULTING_WORK_ITEM_TYPES.length} work item types`);

  // 2. Project template
  const existingPt = await prisma.projectTemplate.findFirst({
    where: { orgId: null, slug: CONSULTING_PROJECT_TEMPLATE.slug },
  });
  let projectTemplate: { id: string };
  if (existingPt) {
    projectTemplate = await prisma.projectTemplate.update({
      where: { id: existingPt.id },
      data: {
        name: CONSULTING_PROJECT_TEMPLATE.name,
        description: CONSULTING_PROJECT_TEMPLATE.description,
        sector: CONSULTING_PROJECT_TEMPLATE.sector,
        defaultConfig: CONSULTING_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  } else {
    projectTemplate = await prisma.projectTemplate.create({
      data: {
        slug: CONSULTING_PROJECT_TEMPLATE.slug,
        sector: CONSULTING_PROJECT_TEMPLATE.sector,
        name: CONSULTING_PROJECT_TEMPLATE.name,
        description: CONSULTING_PROJECT_TEMPLATE.description,
        defaultConfig: CONSULTING_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  }
  console.log(`  consulting: upserted project template (id=${projectTemplate.id})`);

  // 3. Board templates
  for (const bt of CONSULTING_BOARD_TEMPLATES) {
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
          sector: "consulting",
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
          sector: "consulting",
          projectTemplateId: projectTemplate.id,
          isBuiltIn: true,
          isPublished: true,
          defaultConfig,
        },
      });
    }
  }
  console.log(`  consulting: upserted ${CONSULTING_BOARD_TEMPLATES.length} board templates`);
}
