import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canManageProject } from "@/lib/rbac/scope";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { ForbiddenError } from "@/lib/rbac/check";
import { success, handleApiError } from "@/lib/api-helpers";
import { runEntityImport } from "@/lib/import/entity-import";
import { ENTITY_DEFS, type EntityImportRequest } from "@/lib/import/entity-fields";

const MAX_ROWS = 5000;
const MAX_CELL = 20_000; // chars per cell
const MAX_BYTES = 12 * 1024 * 1024; // reject oversized bodies before parsing

const entityKeys = ENTITY_DEFS.map((e) => e.key) as [string, ...string[]];

const importSchema = z.object({
  entity: z.enum(entityKeys),
  mode: z.enum(["validate", "commit"]),
  mapping: z.record(z.string(), z.string()),
  rows: z
    .array(
      z.record(
        z.string(),
        z.union([z.string().max(MAX_CELL), z.number(), z.null()]),
      ),
    )
    .max(MAX_ROWS),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Generic, entity-aware import (everything EXCEPT work items, which keep their
 * own /work-items/import path). Accepts { entity, mode, mapping, rows }; in
 * validate mode it returns counts only (no writes), in commit mode it performs
 * idempotent create-or-skip and returns the created count. Per-row errors are
 * collected without aborting the import.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;

    // Reject oversized bodies before buffering/parsing.
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BYTES) {
      return new Response("Payload too large", { status: 413 });
    }

    // Resolve the org by id (the wizard sends a UUID) or by slug as a fallback,
    // mirroring the insensitive key-match other routes tolerate.
    const org = await prisma.organization.findFirst({
      where: UUID_RE.test(orgId) ? { id: orgId } : { slug: { equals: orgId, mode: "insensitive" } },
      select: { id: true, slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    // Resolve the project within this org by id or (insensitive) key.
    const project = await prisma.project.findFirst({
      where: {
        orgId: org.id,
        ...(UUID_RE.test(projectId)
          ? { id: projectId }
          : { key: { equals: projectId, mode: "insensitive" } }),
      },
      select: { id: true },
    });
    if (!project) return new Response("Project not found", { status: 404 });

    // Bulk import is a project-management action: allow a project MANAGER of
    // this project OR an org-wide PROJECT_UPDATE holder (mirrors schedule/route).
    const allowed =
      hasPermission(ctx.permissions, Permission.PROJECT_UPDATE) ||
      (await canManageProject(ctx, project.id));
    if (!allowed) throw new ForbiddenError("Cannot manage this project");

    const body = await request.json();
    const req = importSchema.parse(body) as EntityImportRequest;

    const report = await runEntityImport(
      { orgId: org.id, projectId: project.id, userId: ctx.userId },
      req,
    );
    return success(report);
  } catch (err) {
    return handleApiError(err);
  }
}
