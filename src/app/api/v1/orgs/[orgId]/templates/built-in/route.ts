import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { BUILT_IN_BOARD_TEMPLATES } from "@/lib/boards/built-in-templates";


// Cross-sector board PRESETS — named boards from every sector template, made
// available to EVERY project so a team can adopt another discipline's board
// (an RFI Tracker on a software project, etc.). Each is a named preset of a
// generic board type; Kanban presets carry their column set via `config`.
const SECTOR_BOARD_PRESETS = [
  // ── Construction / AEC ──────────────────────────────────────────────
  { slug: "aec.phase-gantt", name: "Phase Gantt", category: "construction", description: "Construction phases on an interactive timeline.", icon: "GanttChart", boardType: "TIMELINE" },
  { slug: "aec.submittal-log", name: "Submittal Log", category: "construction", description: "Track submittals and their approval status.", icon: "Table2", boardType: "TABLE" },
  { slug: "aec.rfi-tracker", name: "RFI Tracker", category: "construction", description: "Log and track RFIs (requests for information).", icon: "Table2", boardType: "TABLE" },
  { slug: "aec.change-orders", name: "Change Orders", category: "construction", description: "Track change orders and cost impacts.", icon: "Table2", boardType: "TABLE" },
  { slug: "aec.daily-logs", name: "Daily Logs", category: "construction", description: "Daily field logs in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "aec.punch-list", name: "Punch List", category: "construction", description: "Punch-list items on a Kanban (open → verified).", icon: "Columns3", boardType: "KANBAN", config: { columns: [
    { name: "Open", key: "open", color: "#ef4444", category: "TODO" },
    { name: "In Progress", key: "in-progress", color: "#fbbf24", category: "IN_PROGRESS" },
    { name: "Verified", key: "verified", color: "#34d399", category: "DONE" },
  ] } },
  { slug: "aec.safety", name: "Safety Incidents", category: "construction", description: "Log and track safety incidents.", icon: "Table2", boardType: "TABLE" },
  // ── Consulting ──────────────────────────────────────────────────────
  { slug: "consulting.phases", name: "Engagement Phases", category: "consulting", description: "Consulting engagement phases on a timeline.", icon: "GanttChart", boardType: "TIMELINE" },
  { slug: "consulting.deliverables", name: "Deliverable Tracker", category: "consulting", description: "Track client deliverables and their status.", icon: "Table2", boardType: "TABLE" },
  { slug: "consulting.timesheet", name: "Billable Timesheet", category: "consulting", description: "Log billable time entries in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "consulting.checkpoints", name: "Checkpoint Calendar", category: "consulting", description: "Client checkpoints on a calendar.", icon: "Calendar", boardType: "CALENDAR" },
  { slug: "consulting.closeout", name: "Closeout Checklist", category: "consulting", description: "Engagement closeout on a Kanban.", icon: "Columns3", boardType: "KANBAN", config: { columns: [
    { name: "Pending", key: "pending", color: "#94a3b8", category: "TODO" },
    { name: "In Review", key: "in-review", color: "#fbbf24", category: "IN_PROGRESS" },
    { name: "Signed Off", key: "signed-off", color: "#34d399", category: "DONE" },
  ] } },
  // ── Education ───────────────────────────────────────────────────────
  { slug: "education.outline", name: "Course Outline", category: "education", description: "Course structure in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "education.assignments", name: "Assignment Tracker", category: "education", description: "Assignments on a Kanban (draft → graded).", icon: "Columns3", boardType: "KANBAN", config: { columns: [
    { name: "Draft", key: "draft", color: "#94a3b8", category: "TODO" },
    { name: "Published", key: "published", color: "#3b82f6", category: "IN_PROGRESS" },
    { name: "Grading", key: "grading", color: "#fbbf24", category: "IN_PROGRESS" },
    { name: "Graded", key: "graded", color: "#34d399", category: "DONE" },
  ] } },
  { slug: "education.calendar", name: "Lesson Calendar", category: "education", description: "Lessons scheduled on a calendar.", icon: "Calendar", boardType: "CALENDAR" },
  { slug: "education.gradebook", name: "Grading Board", category: "education", description: "Grading metrics dashboard.", icon: "LayoutDashboard", boardType: "DASHBOARD" },
  { slug: "education.curriculum", name: "Curriculum Roadmap", category: "education", description: "Curriculum plan on a roadmap.", icon: "Map", boardType: "ROADMAP" },
  { slug: "education.conferences", name: "Student Conferences", category: "education", description: "Student conferences on a calendar.", icon: "Calendar", boardType: "CALENDAR" },
  // ── Events ──────────────────────────────────────────────────────────
  { slug: "event.run-of-show", name: "Run-of-Show Timeline", category: "events", description: "Event run-of-show on a timeline.", icon: "GanttChart", boardType: "TIMELINE" },
  { slug: "event.vendors", name: "Vendor Tracker", category: "events", description: "Track event vendors in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "event.logistics", name: "Logistics Checklist", category: "events", description: "Event logistics on a Kanban.", icon: "Columns3", boardType: "KANBAN", config: { columns: [
    { name: "To Do", key: "to-do", color: "#94a3b8", category: "TODO" },
    { name: "In Progress", key: "in-progress", color: "#fbbf24", category: "IN_PROGRESS" },
    { name: "Confirmed", key: "confirmed", color: "#34d399", category: "DONE" },
  ] } },
  { slug: "event.risk", name: "Risk + Contingency", category: "events", description: "Event risks & contingencies (RAID).", icon: "ShieldAlert", boardType: "RAID" },
  { slug: "event.attendees", name: "Attendee CRM", category: "events", description: "Attendee list in a table.", icon: "Table2", boardType: "TABLE" },
  // ── Manufacturing ───────────────────────────────────────────────────
  { slug: "manufacturing.work-orders", name: "Work-Order Kanban", category: "manufacturing", description: "Production work orders on a Kanban.", icon: "Columns3", boardType: "KANBAN", config: { columns: [
    { name: "Queued", key: "queued", color: "#94a3b8", category: "TODO" },
    { name: "In Setup", key: "in-setup", color: "#fbbf24", category: "IN_PROGRESS" },
    { name: "Running", key: "running", color: "#3b82f6", category: "IN_PROGRESS" },
    { name: "QC Hold", key: "qc-hold", color: "#ef4444", category: "IN_PROGRESS" },
    { name: "Complete", key: "complete", color: "#34d399", category: "DONE" },
  ] } },
  { slug: "manufacturing.ncr-tracker", name: "Quality NCR Tracker", category: "manufacturing", description: "Track non-conformance reports (NCRs).", icon: "Table2", boardType: "TABLE" },
  { slug: "manufacturing.downtime", name: "Downtime Calendar", category: "manufacturing", description: "Planned/unplanned downtime on a calendar.", icon: "Calendar", boardType: "CALENDAR" },
  { slug: "manufacturing.bom", name: "BOM Table", category: "manufacturing", description: "Bill of materials in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "manufacturing.inspections", name: "Inspection Checklist", category: "manufacturing", description: "Inspections in a table.", icon: "Table2", boardType: "TABLE" },
  // ── Ops / ITSM ──────────────────────────────────────────────────────
  { slug: "ops.incident-board", name: "Incident Board", category: "operations", description: "Ops incidents on a Kanban (new → closed).", icon: "Columns3", boardType: "KANBAN", config: { columns: [
    { name: "New", key: "new", color: "#ef4444", category: "TODO" },
    { name: "Triaged", key: "triaged", color: "#f59e0b", category: "TODO" },
    { name: "In Progress", key: "in-progress", color: "#3b82f6", category: "IN_PROGRESS" },
    { name: "Resolved", key: "resolved", color: "#34d399", category: "DONE" },
    { name: "Closed", key: "closed", color: "#64748b", category: "DONE" },
  ] } },
  { slug: "ops.change-queue", name: "Change Request Queue", category: "operations", description: "Change requests in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "ops.runbooks", name: "Runbook Checklist", category: "operations", description: "Runbook steps in a table.", icon: "Table2", boardType: "TABLE" },
  { slug: "ops.sla-dashboard", name: "SLA Dashboard", category: "operations", description: "SLA metrics dashboard.", icon: "LayoutDashboard", boardType: "DASHBOARD" },
  { slug: "ops.oncall", name: "On-Call Rotation", category: "operations", description: "On-call schedule on a calendar.", icon: "Calendar", boardType: "CALENDAR" },
  { slug: "ops.postmortems", name: "Postmortem Tracker", category: "operations", description: "Track postmortems in a table.", icon: "Table2", boardType: "TABLE" },
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
