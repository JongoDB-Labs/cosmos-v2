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

// Cross-sector board PRESETS — named boards from every sector template, made
// available to EVERY project so a team can adopt another discipline's board
// (an RFI Tracker on a software project, etc.). Each is a named preset of a
// generic board type; Kanban presets carry their column set via `config`.
const SECTOR_BOARD_PRESETS = [
  // ── Construction / AEC ──────────────────────────────────────────────
  { slug: "aec.phase-gantt", name: "Phase Gantt", category: "planning", description: "Construction phases on an interactive timeline.", icon: "GanttChart", boardType: "TIMELINE" },
  { slug: "aec.submittal-log", name: "Submittal Log", category: "tracking", description: "Track submittals and their approval status.", icon: "Table2", boardType: "TABLE" },
  { slug: "aec.rfi-tracker", name: "RFI Tracker", category: "tracking", description: "Log and track RFIs (requests for information).", icon: "Table2", boardType: "TABLE" },
  { slug: "aec.change-orders", name: "Change Orders", category: "tracking", description: "Track change orders and cost impacts.", icon: "Table2", boardType: "TABLE" },
  { slug: "aec.daily-logs", name: "Daily Logs", category: "tracking", description: "Daily field logs in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "aec.punch-list", name: "Punch List", category: "tracking", description: "Punch-list items on a Kanban (open → verified).", icon: "Columns3", boardType: "KANBAN", config: { columns: [
    { name: "Open", key: "open", color: "#ef4444", category: "TODO" },
    { name: "In Progress", key: "in-progress", color: "#fbbf24", category: "IN_PROGRESS" },
    { name: "Verified", key: "verified", color: "#34d399", category: "DONE" },
  ] } },
  { slug: "aec.safety", name: "Safety Incidents", category: "tracking", description: "Log and track safety incidents.", icon: "Table2", boardType: "TABLE" },
  // ── Consulting ──────────────────────────────────────────────────────
  { slug: "consulting.phases", name: "Engagement Phases", category: "planning", description: "Consulting engagement phases on a timeline.", icon: "GanttChart", boardType: "TIMELINE" },
  { slug: "consulting.deliverables", name: "Deliverable Tracker", category: "tracking", description: "Track client deliverables and their status.", icon: "Table2", boardType: "TABLE" },
  { slug: "consulting.timesheet", name: "Billable Timesheet", category: "tracking", description: "Log billable time entries in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "consulting.checkpoints", name: "Checkpoint Calendar", category: "planning", description: "Client checkpoints on a calendar.", icon: "Calendar", boardType: "CALENDAR" },
  { slug: "consulting.closeout", name: "Closeout Checklist", category: "tracking", description: "Engagement closeout on a Kanban.", icon: "Columns3", boardType: "KANBAN", config: { columns: [
    { name: "Pending", key: "pending", color: "#94a3b8", category: "TODO" },
    { name: "In Review", key: "in-review", color: "#fbbf24", category: "IN_PROGRESS" },
    { name: "Signed Off", key: "signed-off", color: "#34d399", category: "DONE" },
  ] } },
  // ── Education ───────────────────────────────────────────────────────
  { slug: "education.outline", name: "Course Outline", category: "planning", description: "Course structure in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "education.assignments", name: "Assignment Tracker", category: "tracking", description: "Assignments on a Kanban (draft → graded).", icon: "Columns3", boardType: "KANBAN", config: { columns: [
    { name: "Draft", key: "draft", color: "#94a3b8", category: "TODO" },
    { name: "Published", key: "published", color: "#3b82f6", category: "IN_PROGRESS" },
    { name: "Grading", key: "grading", color: "#fbbf24", category: "IN_PROGRESS" },
    { name: "Graded", key: "graded", color: "#34d399", category: "DONE" },
  ] } },
  { slug: "education.calendar", name: "Lesson Calendar", category: "planning", description: "Lessons scheduled on a calendar.", icon: "Calendar", boardType: "CALENDAR" },
  { slug: "education.gradebook", name: "Grading Board", category: "analytics", description: "Grading metrics dashboard.", icon: "LayoutDashboard", boardType: "DASHBOARD" },
  { slug: "education.curriculum", name: "Curriculum Roadmap", category: "planning", description: "Curriculum plan on a roadmap.", icon: "Map", boardType: "ROADMAP" },
  { slug: "education.conferences", name: "Student Conferences", category: "planning", description: "Student conferences on a calendar.", icon: "Calendar", boardType: "CALENDAR" },
  // ── Events ──────────────────────────────────────────────────────────
  { slug: "event.run-of-show", name: "Run-of-Show Timeline", category: "planning", description: "Event run-of-show on a timeline.", icon: "GanttChart", boardType: "TIMELINE" },
  { slug: "event.vendors", name: "Vendor Tracker", category: "tracking", description: "Track event vendors in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "event.logistics", name: "Logistics Checklist", category: "tracking", description: "Event logistics on a Kanban.", icon: "Columns3", boardType: "KANBAN", config: { columns: [
    { name: "To Do", key: "to-do", color: "#94a3b8", category: "TODO" },
    { name: "In Progress", key: "in-progress", color: "#fbbf24", category: "IN_PROGRESS" },
    { name: "Confirmed", key: "confirmed", color: "#34d399", category: "DONE" },
  ] } },
  { slug: "event.risk", name: "Risk + Contingency", category: "tracking", description: "Event risks & contingencies (RAID).", icon: "ShieldAlert", boardType: "RAID" },
  { slug: "event.attendees", name: "Attendee CRM", category: "tracking", description: "Attendee list in a table.", icon: "Table2", boardType: "TABLE" },
  // ── Manufacturing ───────────────────────────────────────────────────
  { slug: "manufacturing.work-orders", name: "Work-Order Kanban", category: "tracking", description: "Production work orders on a Kanban.", icon: "Columns3", boardType: "KANBAN", config: { columns: [
    { name: "Queued", key: "queued", color: "#94a3b8", category: "TODO" },
    { name: "In Setup", key: "in-setup", color: "#fbbf24", category: "IN_PROGRESS" },
    { name: "Running", key: "running", color: "#3b82f6", category: "IN_PROGRESS" },
    { name: "QC Hold", key: "qc-hold", color: "#ef4444", category: "IN_PROGRESS" },
    { name: "Complete", key: "complete", color: "#34d399", category: "DONE" },
  ] } },
  { slug: "manufacturing.ncr-tracker", name: "Quality NCR Tracker", category: "tracking", description: "Track non-conformance reports (NCRs).", icon: "Table2", boardType: "TABLE" },
  { slug: "manufacturing.downtime", name: "Downtime Calendar", category: "planning", description: "Planned/unplanned downtime on a calendar.", icon: "Calendar", boardType: "CALENDAR" },
  { slug: "manufacturing.bom", name: "BOM Table", category: "tracking", description: "Bill of materials in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "manufacturing.inspections", name: "Inspection Checklist", category: "tracking", description: "Inspections in a table.", icon: "Table2", boardType: "TABLE" },
  // ── Ops / ITSM ──────────────────────────────────────────────────────
  { slug: "ops.incident-board", name: "Incident Board", category: "tracking", description: "Ops incidents on a Kanban (new → closed).", icon: "Columns3", boardType: "KANBAN", config: { columns: [
    { name: "New", key: "new", color: "#ef4444", category: "TODO" },
    { name: "Triaged", key: "triaged", color: "#f59e0b", category: "TODO" },
    { name: "In Progress", key: "in-progress", color: "#3b82f6", category: "IN_PROGRESS" },
    { name: "Resolved", key: "resolved", color: "#34d399", category: "DONE" },
    { name: "Closed", key: "closed", color: "#64748b", category: "DONE" },
  ] } },
  { slug: "ops.change-queue", name: "Change Request Queue", category: "tracking", description: "Change requests in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "ops.runbooks", name: "Runbook Checklist", category: "tracking", description: "Runbook steps in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "ops.sla-dashboard", name: "SLA Dashboard", category: "analytics", description: "SLA metrics dashboard.", icon: "LayoutDashboard", boardType: "DASHBOARD" },
  { slug: "ops.oncall", name: "On-Call Rotation", category: "planning", description: "On-call schedule on a calendar.", icon: "Calendar", boardType: "CALENDAR" },
  { slug: "ops.postmortems", name: "Postmortem Tracker", category: "tracking", description: "Track postmortems in a table.", icon: "Table2", boardType: "TABLE" },
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

    return success([...BUILT_IN_BOARD_TEMPLATES, ...SECTOR_BOARD_PRESETS]);
  } catch (error) {
    return handleApiError(error);
  }
}
