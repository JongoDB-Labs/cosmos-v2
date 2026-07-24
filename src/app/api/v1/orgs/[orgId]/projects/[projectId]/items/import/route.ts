import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { itemImportSchema, ingestItems } from "@/lib/ingest/items";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

const ITEM_TYPES = [
  "ISSUE",
  "MILESTONE",
  "OBJECTIVE",
  "GOAL",
  "INTERVAL",
  "ROADMAP_NODE",
] as const;

/**
 * GET — the structured-ingest template: the JSON shape, a worked example, and a
 * ready-to-paste LLM instruction prompt. A user feeds their own document + this
 * prompt to the LLM of their choice, gets back a conformant `items` array, and
 * POSTs it. A bearer API key OR a session works (PROJECT_READ).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await resolveAuth(request, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    // The template is the same for any project, but verify the project belongs
    // to this org so a cross-org projectId returns 404 instead of a 200 (which
    // would leak existence). The POST path guards inside ingestItems.
    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
      select: { id: true },
    });
    if (!project) return new Response("Not found", { status: 404 });

    return success({
      endpoint: `/api/v1/orgs/${orgId}/projects/${projectId}/items/import`,
      method: "POST",
      types: ITEM_TYPES,
      request: {
        mode: "create (default; the only mode today)",
        items: [
          {
            type: "ISSUE",
            title: "string (required)",
            description: "markdown (optional)",
            columnKey: "board column key (optional; defaults to first column)",
            priority: "CRITICAL | HIGH | MEDIUM | LOW (optional; default MEDIUM)",
            tags: "string[] (optional)",
            dueDate: "ISO date (optional)",
            startDate: "ISO date (optional)",
          },
          {
            type: "MILESTONE",
            title: "string (required)",
            description: "markdown (optional)",
            dueDate: "ISO date (optional; default +30 days)",
          },
          {
            type: "OBJECTIVE",
            title: "string (required)",
            description: "markdown (optional)",
            period: "e.g. 'Q3 2026' (optional)",
            status: "DRAFT | ACTIVE | COMPLETED | CANCELLED (optional; default ACTIVE)",
          },
          {
            type: "GOAL",
            title: "string (required)",
            description: "markdown (optional)",
            status: "PLANNED | ON_TRACK | AT_RISK | OFF_TRACK | ACHIEVED (optional; default PLANNED)",
            targetDate: "ISO date (optional)",
            progressMode: "MANUAL | AUTO (optional; default MANUAL)",
          },
          {
            type: "INTERVAL",
            name: "string (required)",
            goal: "string (optional)",
            startDate: "ISO date (optional; default now)",
            endDate: "ISO date (optional; default +14 days)",
            intervalKind: "SPRINT | PHASE | MODULE | RUN | EVENT_DAY | RELEASE | ITERATION (optional; default SPRINT)",
          },
          {
            type: "ROADMAP_NODE",
            kind: "SECTION | SUBPHASE | LOE | RISK | DECISION | STAKEHOLDER | MILESTONE (required)",
            title: "string (required)",
            externalRef: "stable id e.g. R-19 / P-1 (optional, unique per project)",
            section: "section number/label (optional)",
            category: "grouping band (optional)",
            body: "markdown — the ACTUAL content (optional)",
            parentRef: "externalRef or anchor of the parent node (optional)",
            sortOrder: "number (optional)",
            meta: "object of structured extras (optional)",
          },
        ],
      },
      example: {
        mode: "create",
        items: [
          { type: "ISSUE", title: "Wire up SSO callback", priority: "HIGH" },
          { type: "MILESTONE", title: "Beta launch", dueDate: "2026-09-01" },
        ],
      },
      prompt:
        "You convert a project document into structured JSON for COSMOS. Read the " +
        "document I provide and emit ONLY a JSON object " +
        '{"mode":"create","items":[...]} where each item has a `type` (one of ' +
        ITEM_TYPES.join(", ") +
        ") plus that type's fields. Use ISSUE for tasks/tickets, MILESTONE for " +
        "dated checkpoints, OBJECTIVE for OKRs, GOAL for delivery goals, INTERVAL for " +
        "sprints/phases, and ROADMAP_NODE for program-roadmap structure (give each " +
        "a `kind` and put the ACTUAL content in `body` as Markdown; use `parentRef` " +
        "to nest). Required fields: every item needs a `title` (INTERVAL uses `name`). " +
        "Do not invent facts; only structure what the document says, and omit " +
        "optional fields you can't fill. Output the JSON object and nothing else.",
    });
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * POST — ingest a structured `items[]` set, creating one row per item (any
 * supported type), attributed to the authenticated principal. A bearer API key
 * OR a session works; gated ITEM_CREATE.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await resolveAuth(request, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_CREATE);

    const body = itemImportSchema.parse(await request.json());
    const report = await ingestItems({
      orgId,
      projectId,
      userId: ctx.userId,
      items: body.items,
      mode: body.mode,
    });
    return created(report);
  } catch (e) {
    return handleApiError(e);
  }
}
