import type { PrismaClient } from "@prisma/client";

interface EducationWorkItemType {
  key: string;
  name: string;
  pluralName: string;
  icon: string;
  color: string;
  sortOrder: number;
  celebrateOnComplete: boolean;
  defaultParentTypeKey?: string;
}

const EDUCATION_WORK_ITEM_TYPES: EducationWorkItemType[] = [
  { key: "education.course", name: "Course", pluralName: "Courses", icon: "BookOpen", color: "#6366f1", sortOrder: 0, celebrateOnComplete: false },
  { key: "education.module", name: "Module", pluralName: "Modules", icon: "Layout", color: "#3b82f6", sortOrder: 1, defaultParentTypeKey: "education.course", celebrateOnComplete: false },
  { key: "education.lesson", name: "Lesson", pluralName: "Lessons", icon: "FileText", color: "#10b981", sortOrder: 2, defaultParentTypeKey: "education.module", celebrateOnComplete: false },
  { key: "education.assignment", name: "Assignment", pluralName: "Assignments", icon: "ClipboardCheck", color: "#f59e0b", sortOrder: 3, defaultParentTypeKey: "education.lesson", celebrateOnComplete: false },
  { key: "education.submission", name: "Submission", pluralName: "Submissions", icon: "Upload", color: "#8b5cf6", sortOrder: 4, defaultParentTypeKey: "education.assignment", celebrateOnComplete: true },
  { key: "education.outcome", name: "Learning Outcome", pluralName: "Learning Outcomes", icon: "Target", color: "#0891b2", sortOrder: 5, celebrateOnComplete: false },
];

const EDUCATION_BOARD_TEMPLATES = [
  {
    slug: "education.outline",
    name: "Course Outline",
    category: "planning",
    boardType: "TABLE",
    sortOrder: 0,
    columns: [],
  },
  {
    slug: "education.assignments",
    name: "Assignment Tracker",
    category: "tracking",
    boardType: "KANBAN",
    sortOrder: 1,
    columns: [
      { name: "Draft", key: "draft", color: "#94a3b8", category: "TODO" },
      { name: "Published", key: "published", color: "#3b82f6", category: "IN_PROGRESS" },
      { name: "Grading", key: "grading", color: "#fbbf24", category: "IN_PROGRESS" },
      { name: "Graded", key: "graded", color: "#34d399", category: "DONE" },
    ],
  },
  {
    slug: "education.calendar",
    name: "Lesson Calendar",
    category: "planning",
    boardType: "CALENDAR",
    sortOrder: 2,
    columns: [],
  },
  {
    slug: "education.gradebook",
    name: "Grading Board",
    category: "analytics",
    boardType: "DASHBOARD",
    sortOrder: 3,
    columns: [],
  },
  {
    slug: "education.curriculum",
    name: "Curriculum Roadmap",
    category: "planning",
    boardType: "ROADMAP",
    sortOrder: 4,
    columns: [],
  },
  {
    slug: "education.conferences",
    name: "Student Conferences",
    category: "planning",
    boardType: "CALENDAR",
    sortOrder: 5,
    columns: [],
  },
];

const EDUCATION_PROJECT_TEMPLATE = {
  slug: "education",
  sector: "education",
  name: "Course",
  description: "Course design with modules, lessons, assignments, and grading.",
  defaultConfig: {
    intervalKinds: ["MODULE"],
    intervalNavLabel: "Modules",
    enabledFeatures: ["goal", "milestone", "risk"],
  },
};

export async function seedEducation(prisma: PrismaClient) {
  // 1. Work item types (orgId: null, projectTemplateId: null for built-ins)
  for (const t of EDUCATION_WORK_ITEM_TYPES) {
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
  console.log(`  education: upserted ${EDUCATION_WORK_ITEM_TYPES.length} work item types`);

  // 2. Project template
  const existingPt = await prisma.projectTemplate.findFirst({
    where: { orgId: null, slug: EDUCATION_PROJECT_TEMPLATE.slug },
  });
  let projectTemplate: { id: string };
  if (existingPt) {
    projectTemplate = await prisma.projectTemplate.update({
      where: { id: existingPt.id },
      data: {
        name: EDUCATION_PROJECT_TEMPLATE.name,
        description: EDUCATION_PROJECT_TEMPLATE.description,
        sector: EDUCATION_PROJECT_TEMPLATE.sector,
        defaultConfig: EDUCATION_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  } else {
    projectTemplate = await prisma.projectTemplate.create({
      data: {
        slug: EDUCATION_PROJECT_TEMPLATE.slug,
        sector: EDUCATION_PROJECT_TEMPLATE.sector,
        name: EDUCATION_PROJECT_TEMPLATE.name,
        description: EDUCATION_PROJECT_TEMPLATE.description,
        defaultConfig: EDUCATION_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  }
  console.log(`  education: upserted project template (id=${projectTemplate.id})`);

  // 3. Board templates
  for (const bt of EDUCATION_BOARD_TEMPLATES) {
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
          sector: "education",
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
          sector: "education",
          projectTemplateId: projectTemplate.id,
          isBuiltIn: true,
          isPublished: true,
          defaultConfig,
        },
      });
    }
  }
  console.log(`  education: upserted ${EDUCATION_BOARD_TEMPLATES.length} board templates`);
}
