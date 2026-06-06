import type { PrismaClient } from "@prisma/client";

interface SoftwareWorkItemType {
  key: string;
  name: string;
  pluralName: string;
  icon: string;
  color: string;
  sortOrder: number;
  celebrateOnComplete: boolean;
  defaultParentTypeKey?: string;
}

const SOFTWARE_WORK_ITEM_TYPES: SoftwareWorkItemType[] = [
  { key: "software.epic", name: "Epic", pluralName: "Epics", icon: "Layers", color: "#8b5cf6", sortOrder: 0, celebrateOnComplete: false },
  { key: "software.story", name: "Story", pluralName: "Stories", icon: "BookOpen", color: "#3b82f6", sortOrder: 1, defaultParentTypeKey: "software.epic", celebrateOnComplete: false },
  { key: "software.task", name: "Task", pluralName: "Tasks", icon: "CheckSquare", color: "#10b981", sortOrder: 2, defaultParentTypeKey: "software.story", celebrateOnComplete: true },
  { key: "software.bug", name: "Bug", pluralName: "Bugs", icon: "Bug", color: "#ef4444", sortOrder: 3, celebrateOnComplete: true },
  { key: "software.subtask", name: "Subtask", pluralName: "Subtasks", icon: "ListChecks", color: "#64748b", sortOrder: 4, defaultParentTypeKey: "software.story", celebrateOnComplete: true },
];

const SOFTWARE_BOARD_TEMPLATES = [
  {
    slug: "software.sprint-board",
    name: "Sprint Board",
    category: "agile",
    boardType: "SCRUM",
    sortOrder: 0,
    columns: ["Sprint Backlog", "In Progress", "Testing", "Done"],
  },
  {
    slug: "software.kanban",
    name: "Kanban",
    category: "agile",
    boardType: "KANBAN",
    sortOrder: 1,
    columns: ["Backlog", "To Do", "In Progress", "Review", "Done"],
  },
  {
    slug: "software.backlog",
    name: "Backlog",
    category: "agile",
    boardType: "BACKLOG",
    sortOrder: 2,
    columns: [],
  },
  {
    slug: "software.bug-tracker",
    name: "Bug Tracker",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 3,
    columns: [],
  },
  {
    slug: "software.release-timeline",
    name: "Release Timeline",
    category: "planning",
    boardType: "TIMELINE",
    sortOrder: 4,
    columns: [],
  },
  {
    slug: "software.raid",
    name: "RAID Log",
    category: "tracking",
    boardType: "RAID",
    sortOrder: 5,
    columns: [],
  },
  {
    slug: "software.dashboard",
    name: "Sprint Dashboard",
    category: "analytics",
    boardType: "DASHBOARD",
    sortOrder: 6,
    columns: [],
  },
];

const SOFTWARE_PROJECT_TEMPLATE = {
  slug: "software",
  sector: "software",
  name: "Software Project",
  description: "Agile development with sprints, boards, and releases",
  defaultConfig: {
    cycleKinds: ["SPRINT", "RELEASE"],
    cycleNavLabel: "Sprints",
    enabledFeatures: ["goal", "milestone", "risk"],
  },
};

export async function seedSoftwareSector(prisma: PrismaClient) {
  // 1. Work item types (orgId: null, projectTemplateId: null for built-ins)
  for (const t of SOFTWARE_WORK_ITEM_TYPES) {
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
  console.log(`  software: upserted ${SOFTWARE_WORK_ITEM_TYPES.length} work item types`);

  // 2. Project template
  const existingPt = await prisma.projectTemplate.findFirst({
    where: { orgId: null, slug: SOFTWARE_PROJECT_TEMPLATE.slug },
  });
  let projectTemplate: { id: string };
  if (existingPt) {
    projectTemplate = await prisma.projectTemplate.update({
      where: { id: existingPt.id },
      data: {
        name: SOFTWARE_PROJECT_TEMPLATE.name,
        description: SOFTWARE_PROJECT_TEMPLATE.description,
        sector: SOFTWARE_PROJECT_TEMPLATE.sector,
        defaultConfig: SOFTWARE_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  } else {
    projectTemplate = await prisma.projectTemplate.create({
      data: {
        slug: SOFTWARE_PROJECT_TEMPLATE.slug,
        sector: SOFTWARE_PROJECT_TEMPLATE.sector,
        name: SOFTWARE_PROJECT_TEMPLATE.name,
        description: SOFTWARE_PROJECT_TEMPLATE.description,
        defaultConfig: SOFTWARE_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  }
  console.log(`  software: upserted project template (id=${projectTemplate.id})`);

  // 3. Board templates
  for (const bt of SOFTWARE_BOARD_TEMPLATES) {
    const existingBt = await prisma.boardTemplate.findFirst({
      where: { orgId: null, slug: bt.slug },
    });
    if (existingBt) {
      await prisma.boardTemplate.update({
        where: { id: existingBt.id },
        data: {
          name: bt.name,
          category: bt.category,
          boardType: bt.boardType,
          sortOrder: bt.sortOrder,
          sector: "software",
          projectTemplateId: projectTemplate.id,
          isBuiltIn: true,
          isPublished: true,
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
          sector: "software",
          projectTemplateId: projectTemplate.id,
          isBuiltIn: true,
          isPublished: true,
        },
      });
    }
  }
  console.log(`  software: upserted ${SOFTWARE_BOARD_TEMPLATES.length} board templates`);
}
