import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { roadmapImportSchema, ROADMAP_NODE_KINDS } from "@/lib/roadmap/types";
import { upsertRoadmapNodes } from "@/lib/roadmap/import";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/**
 * GET — the ingest template: JSON schema, a worked example, and a ready-to-paste
 * LLM instruction prompt. A user feeds their own roadmap document + this prompt
 * to the LLM of their choice, gets back a conformant `nodes` array, and POSTs it.
 * Returned to any project member (PROJECT_READ).
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    return success({
      endpoint: `/api/v1/orgs/${orgId}/projects/${projectId}/roadmap-nodes/import`,
      method: "POST",
      kinds: ROADMAP_NODE_KINDS,
      request: {
        mode: "replace | merge (default replace)",
        nodes: [
          {
            kind: "SECTION | SUBPHASE | LOE | RISK | DECISION | STAKEHOLDER | MILESTONE",
            title: "string (required)",
            externalRef: "stable id e.g. R-19 / DP-04 / SP-3 (optional, unique per project)",
            section: "section number/label (optional)",
            category: "grouping band e.g. 'Authorization' (optional)",
            body: "markdown — the ACTUAL content, not just an id (optional)",
            parentRef: "externalRef or anchor of the parent node (optional)",
            sortOrder: "number (optional; defaults to array order)",
            meta: "object of structured extras (optional)",
          },
        ],
      },
      example: {
        mode: "replace",
        nodes: [
          {
            kind: "SECTION",
            externalRef: "S-1",
            section: "1",
            title: "§1. Program Overview",
            body: "What the program delivers and why, in plain terms.",
          },
          {
            kind: "SUBPHASE",
            externalRef: "P-1",
            title: "P-1 — Discovery & Planning",
            body: "Scope, stakeholders, and the build plan.",
            parentRef: "S-1",
          },
          {
            kind: "RISK",
            externalRef: "R-1",
            category: "Schedule",
            title: "R-1 — Vendor onboarding delay",
            body: "**Likelihood:** Medium · **Impact:** High\n\nOnboarding may slip the build start.\n\n**Mitigation:** Start paperwork in P-1.",
            parentRef: "S-1",
            meta: { likelihood: "Medium", impact: "High" },
          },
        ],
      },
      llmPrompt:
        "You convert a program roadmap document into structured JSON for the COSMOS Roadmap view. " +
        "Read the roadmap I provide and emit ONLY a JSON object {\"mode\":\"replace\",\"nodes\":[...]} " +
        "matching this contract: each node needs a `kind` (one of " +
        ROADMAP_NODE_KINDS.join(", ") +
        ") and a `title`. Give each addressable item a short stable `externalRef` " +
        "(e.g. R-1, DP-1, P-1, LOE-1) and put the ACTUAL content into `body` as Markdown — never just restate the id. " +
        "Use `parentRef` (an externalRef) to nest items under their section/phase. " +
        "Group registers with `category`. Do not invent facts; only structure what the document says. " +
        "Output the JSON object and nothing else.",
    });
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * POST — ingest a roadmap node set (replace or merge). Gated PROJECT_UPDATE.
 * Idempotent: nodes are keyed by anchor/externalRef so re-ingesting is safe.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const { mode, nodes } = roadmapImportSchema.parse(await request.json());
    const report = await upsertRoadmapNodes(prisma, orgId, projectId, nodes, mode);
    return success(report);
  } catch (e) {
    return handleApiError(e);
  }
}
