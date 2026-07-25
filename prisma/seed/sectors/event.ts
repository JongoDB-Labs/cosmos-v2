import type { PrismaClient } from "@prisma/client";

interface EventWorkItemType {
  key: string;
  name: string;
  pluralName: string;
  icon: string;
  color: string;
  sortOrder: number;
  celebrateOnComplete: boolean;
  defaultParentTypeKey?: string;
}

const EVENT_WORK_ITEM_TYPES: EventWorkItemType[] = [
  { key: "event.event_day", name: "Event Day", pluralName: "Event Days", icon: "CalendarDays", color: "#6366f1", sortOrder: 0, celebrateOnComplete: false },
  { key: "event.session", name: "Session", pluralName: "Sessions", icon: "Clock", color: "#3b82f6", sortOrder: 1, defaultParentTypeKey: "event.event_day", celebrateOnComplete: false },
  { key: "event.vendor", name: "Vendor", pluralName: "Vendors", icon: "Store", color: "#10b981", sortOrder: 2, celebrateOnComplete: false },
  { key: "event.logistics_item", name: "Logistics Item", pluralName: "Logistics Items", icon: "Truck", color: "#f59e0b", sortOrder: 3, celebrateOnComplete: false },
  { key: "event.run_of_show_item", name: "Run of Show Item", pluralName: "Run of Show Items", icon: "ListOrdered", color: "#8b5cf6", sortOrder: 4, defaultParentTypeKey: "event.session", celebrateOnComplete: false },
  { key: "event.permit", name: "Permit", pluralName: "Permits", icon: "FileCheck", color: "#0891b2", sortOrder: 5, celebrateOnComplete: false },
  { key: "event.bid", name: "Bid", pluralName: "Bids", icon: "Tag", color: "#64748b", sortOrder: 6, celebrateOnComplete: false },
  { key: "event.contract", name: "Contract", pluralName: "Contracts", icon: "FileSignature", color: "#059669", sortOrder: 7, defaultParentTypeKey: "event.bid", celebrateOnComplete: false },
];

const EVENT_BOARD_TEMPLATES = [
  {
    slug: "event.run-of-show",
    name: "Run-of-Show Timeline",
    category: "planning",
    boardType: "TIMELINE",
    sortOrder: 0,
    columns: [],
  },
  {
    slug: "event.vendors",
    name: "Vendor Tracker",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 1,
    columns: [],
  },
  {
    slug: "event.logistics",
    name: "Logistics Checklist",
    category: "tracking",
    boardType: "KANBAN",
    sortOrder: 2,
    columns: [
      { name: "To Do", key: "to-do", color: "#94a3b8", category: "TODO" },
      { name: "In Progress", key: "in-progress", color: "#fbbf24", category: "IN_PROGRESS" },
      { name: "Confirmed", key: "confirmed", color: "#34d399", category: "DONE" },
    ],
  },
  {
    slug: "event.risk",
    name: "Risk + Contingency",
    category: "tracking",
    boardType: "RAID",
    sortOrder: 3,
    columns: [],
  },
  {
    slug: "event.attendees",
    name: "Attendee CRM",
    category: "tracking",
    boardType: "TABLE",
    sortOrder: 4,
    columns: [],
  },
];

const EVENT_PROJECT_TEMPLATE = {
  slug: "event",
  sector: "event",
  name: "Event",
  description: "Run-of-show, vendor management, logistics, and risk planning.",
  defaultConfig: {
    intervalKinds: ["EVENT_DAY"],
    cycleNavLabel: "Days",
    enabledFeatures: ["milestone", "kpi", "risk", "decision", "meeting_note"],
  },
};

export async function seedEvent(prisma: PrismaClient) {
  // 1. Work item types (orgId: null, projectTemplateId: null for built-ins)
  for (const t of EVENT_WORK_ITEM_TYPES) {
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
  console.log(`  event: upserted ${EVENT_WORK_ITEM_TYPES.length} work item types`);

  // 2. Project template
  const existingPt = await prisma.projectTemplate.findFirst({
    where: { orgId: null, slug: EVENT_PROJECT_TEMPLATE.slug },
  });
  let projectTemplate: { id: string };
  if (existingPt) {
    projectTemplate = await prisma.projectTemplate.update({
      where: { id: existingPt.id },
      data: {
        name: EVENT_PROJECT_TEMPLATE.name,
        description: EVENT_PROJECT_TEMPLATE.description,
        sector: EVENT_PROJECT_TEMPLATE.sector,
        defaultConfig: EVENT_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  } else {
    projectTemplate = await prisma.projectTemplate.create({
      data: {
        slug: EVENT_PROJECT_TEMPLATE.slug,
        sector: EVENT_PROJECT_TEMPLATE.sector,
        name: EVENT_PROJECT_TEMPLATE.name,
        description: EVENT_PROJECT_TEMPLATE.description,
        defaultConfig: EVENT_PROJECT_TEMPLATE.defaultConfig,
        isBuiltIn: true,
        isPublished: true,
      },
    });
  }
  console.log(`  event: upserted project template (id=${projectTemplate.id})`);

  // 3. Board templates
  for (const bt of EVENT_BOARD_TEMPLATES) {
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
          sector: "event",
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
          sector: "event",
          projectTemplateId: projectTemplate.id,
          isBuiltIn: true,
          isPublished: true,
          defaultConfig,
        },
      });
    }
  }
  console.log(`  event: upserted ${EVENT_BOARD_TEMPLATES.length} board templates`);
}
