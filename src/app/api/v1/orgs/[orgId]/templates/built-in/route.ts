import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

const BUILT_IN_BOARD_TEMPLATES = [
  {
    slug: "kanban",
    name: "Kanban Board",
    category: "agile",
    methodology: "kanban",
    description: "Visual workflow with drag-drop columns, WIP limits, and swimlanes",
    icon: "Columns3",
    boardType: "KANBAN",
  },
  {
    slug: "scrum",
    name: "Scrum Board",
    category: "agile",
    methodology: "scrum",
    description: "Sprint-focused board with burndown charts and velocity tracking",
    icon: "Timer",
    boardType: "SCRUM",
  },
  {
    slug: "backlog",
    name: "Backlog",
    category: "agile",
    description: "Prioritized list with sprint assignment and story point estimation",
    icon: "ListOrdered",
    boardType: "BACKLOG",
  },
  {
    slug: "table",
    name: "Table View",
    category: "agile",
    description: "Configurable columns with sorting, grouping, and inline editing",
    icon: "Table2",
    boardType: "TABLE",
  },
  {
    slug: "timeline",
    name: "Timeline / Gantt",
    category: "planning",
    methodology: "waterfall",
    description: "Interactive scheduler — drag to reschedule, dependencies, critical path",
    icon: "GanttChart",
    boardType: "TIMELINE",
  },
  {
    slug: "release-timeline",
    name: "Release Timeline",
    category: "planning",
    description: "Static big-picture snapshot — increments, deliverables & milestones by month",
    icon: "CalendarRange",
    boardType: "TIMELINE",
    config: { mode: "release-timeline" },
  },
  {
    slug: "roadmap",
    name: "Roadmap",
    category: "planning",
    description: "Strategic epic swimlanes across increments, with feature roll-up",
    icon: "Map",
    boardType: "ROADMAP",
  },
  {
    slug: "calendar",
    name: "Calendar",
    category: "planning",
    description: "Sprint ceremonies, due dates, month/week/day views",
    icon: "CalendarDays",
    boardType: "CALENDAR",
  },
  {
    slug: "okr",
    name: "OKR View",
    category: "strategy",
    methodology: "okr",
    description: "Objectives with key results, hierarchical status, and confidence scoring",
    icon: "Target",
    boardType: "OKR",
  },
  {
    slug: "portfolio",
    name: "Portfolio",
    category: "strategy",
    description: "Cross-project status grid with resource allocation and budget tracking",
    icon: "LayoutGrid",
    boardType: "PORTFOLIO",
  },
  {
    slug: "dashboard",
    name: "Dashboard",
    category: "analytics",
    description: "Custom widget composition with metrics, charts, lists, and status summaries",
    icon: "BarChart3",
    boardType: "DASHBOARD",
  },
  {
    slug: "raid",
    name: "RAID Log",
    category: "tracking",
    methodology: "waterfall",
    description: "Risks, Actions, Issues, Decisions table with severity, owner, and status",
    icon: "ShieldAlert",
    boardType: "RAID",
  },
  {
    slug: "cfd",
    name: "Cumulative Flow",
    category: "analytics",
    methodology: "kanban",
    description: "Stacked area chart showing work item distribution over time",
    icon: "AreaChart",
    boardType: "CFD",
  },
  {
    slug: "program",
    name: "Program Board (SAFe)",
    category: "enterprise",
    methodology: "safe",
    description: "PI planning grid with team swimlanes and feature-to-team mapping",
    icon: "Network",
    boardType: "PROGRAM",
  },
  {
    // A FEATURE view (not a board type): selecting it enables the project's
    // `pm-dashboard` feature flag and opens the dashboard, rather than creating a
    // Board row. The gallery branches on `feature` vs `boardType`.
    slug: "pm-dashboard",
    name: "PM Dashboard",
    category: "enterprise",
    methodology: "govcon",
    description: "GovCon program-management suite: risk, change, blocker, schedule, deliverables, vendors, staffing & CLIN registers with drill-down, derived metrics, and Excel export.",
    icon: "BarChart3",
    feature: "pm-dashboard",
  },
];

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TEMPLATE_READ);

    return success(BUILT_IN_BOARD_TEMPLATES);
  } catch (error) {
    return handleApiError(error);
  }
}
