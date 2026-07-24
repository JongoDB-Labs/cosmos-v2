import type { PrismaClient } from "@prisma/client";

interface OpsWorkItemType {
  key: string;
  name: string;
  pluralName: string;
  icon: string;
  color: string;
  sortOrder: number;
  celebrateOnComplete: boolean;
  defaultParentTypeKey?: string;
}

const OPS_WORK_ITEM_TYPES: OpsWorkItemType[] = [
  { key: "ops.problem", name: "Problem", pluralName: "Problems", icon: "AlertOctagon", color: "#dc2626", sortOrder: 0, celebrateOnComplete: false },
  { key: "ops.incident", name: "Incident", pluralName: "Incidents", icon: "AlertTriangle", color: "#ef4444", sortOrder: 1, defaultParentTypeKey: "ops.problem", celebrateOnComplete: false },
  { key: "ops.action_item", name: "Action Item", pluralName: "Action Items", icon: "CheckCircle", color: "#10b981", sortOrder: 2, defaultParentTypeKey: "ops.incident", celebrateOnComplete: true },
  { key: "ops.change_request", name: "Change Request", pluralName: "Change Requests", icon: "GitPullRequest", color: "#3b82f6", sortOrder: 3, celebrateOnComplete: false },
  { key: "ops.implementation_task", name: "Implementation Task", pluralName: "Implementation Tasks", icon: "Wrench", color: "#6366f1", sortOrder: 4, defaultParentTypeKey: "ops.change_request", celebrateOnComplete: true },
  { key: "ops.service_request", name: "Service Request", pluralName: "Service Requests", icon: "Ticket", color: "#8b5cf6", sortOrder: 5, celebrateOnComplete: false },
  { key: "ops.postmortem", name: "Postmortem", pluralName: "Postmortems", icon: "FileSearch", color: "#64748b", sortOrder: 6, celebrateOnComplete: false },
];

const OPS_BOARD_TEMPLATES = [
  {
    slug: "ops.incident-board",
    name: "Incident Board",
    category: "tracking",
    boardType: "KANBAN",
    sortOrder: 0,
    columns: [
      { name: "New", key: "new", color: "#ef4444", category: "TODO" },
      { name: "Triaged", key: "triaged", color: "#f59e0b", category: "TODO" },
      { name: "In Progress", key: "in-progress", color: "#3b82f6", category: "IN_PROGRESS" },
      { name: "Resolved", key: "resolved", color: "#34d399", category: "DONE" },
      { name: "Closed", key: "closed", color: "#64748b", category: "DONE" },
    ],
  },
  {
    slug: "ops.change-queue",
    name: "Change Request Queue",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 1,
    columns: [],
  },
  {
    slug: "ops.runbooks",
    name: "Runbook Checklist",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 2,
    columns: [],
  },
  {
    slug: "ops.sla-dashboard",
    name: "SLA Dashboard",
    category: "analytics",
    boardType: "DASHBOARD",
    sortOrder: 3,
    columns: [],
  },
  {
    slug: "ops.oncall",
    name: "On-Call Rotation",
    category: "planning",
    boardType: "CALENDAR",
    sortOrder: 4,
    columns: [],
  },
  {
    slug: "ops.postmortems",
    name: "Postmortem Tracker",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 5,
    columns: [],
  },
];

const OPS_PROJECT_TEMPLATE = {
  slug: "ops",
  sector: "ops",
  name: "Operations Workspace",
  description: "Incident management, change requests, runbooks, and SLA tracking.",
  defaultConfig: {
    intervalKinds: ["RELEASE"],
    intervalNavLabel: "Releases",
    enabledFeatures: ["kpi", "risk", "decision", "meeting_note"],
  },
};

export async function seedOps(prisma: PrismaClient) {
  // 1. Work item types (orgId: null, projectTemplateId: null for built-ins)
  for (const t of OPS_WORK_ITEM_TYPES) {
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
  console.log(`  ops: upserted ${OPS_WORK_ITEM_TYPES.length} work item types`);

  // 2. Project template
  const existingPt = await prisma.projectTemplate.findFirst({
    where: { orgId: null, slug: OPS_PROJECT_TEMPLATE.slug },
  });
  let projectTemplate: { id: string };
  if (existingPt) {
    projectTemplate = await prisma.projectTemplate.update({
      where: { id: existingPt.id },
      data: {
        name: OPS_PROJECT_TEMPLATE.name,
        description: OPS_PROJECT_TEMPLATE.description,
        sector: OPS_PROJECT_TEMPLATE.sector,
        defaultConfig: OPS_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  } else {
    projectTemplate = await prisma.projectTemplate.create({
      data: {
        slug: OPS_PROJECT_TEMPLATE.slug,
        sector: OPS_PROJECT_TEMPLATE.sector,
        name: OPS_PROJECT_TEMPLATE.name,
        description: OPS_PROJECT_TEMPLATE.description,
        defaultConfig: OPS_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  }
  console.log(`  ops: upserted project template (id=${projectTemplate.id})`);

  // 3. Board templates
  for (const bt of OPS_BOARD_TEMPLATES) {
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
          sector: "ops",
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
          sector: "ops",
          projectTemplateId: projectTemplate.id,
          isBuiltIn: true,
          isPublished: true,
          defaultConfig,
        },
      });
    }
  }
  console.log(`  ops: upserted ${OPS_BOARD_TEMPLATES.length} board templates`);
}
