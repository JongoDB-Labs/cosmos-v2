import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { success, handleApiError } from "@/lib/api-helpers";
import { runImport } from "@/lib/import/import-engine";
import type { ImportRequest } from "@/lib/import/work-item-fields";

const MAX_ROWS = 5000;
const MAX_CELL = 20_000; // chars per cell — bounds the verbatim sourceRecord
const MAX_BYTES = 12 * 1024 * 1024; // reject oversized bodies before parsing

const priorityEnum = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

const importSchema = z.object({
  mode: z.enum(["validate", "commit"]),
  mapping: z.record(z.string(), z.string()),
  valueMaps: z.object({
    status: z.record(z.string(), z.string()).optional(),
    type: z.record(z.string(), z.string()).optional(),
    priority: z.record(z.string(), priorityEnum).optional(),
    assignee: z.record(z.string(), z.string()).optional(),
  }),
  rows: z.array(z.record(z.string(), z.string().max(MAX_CELL))).max(MAX_ROWS),
  defaults: z.object({
    columnKey: z.string().min(1),
    workItemTypeId: z.string().uuid(),
    priority: priorityEnum,
  }),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;

    // Reject oversized bodies before buffering/parsing (sourceRecord stores the
    // verbatim rows, so an unbounded payload is a memory/DB-bloat vector).
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BYTES) {
      return new Response("Payload too large", { status: 413 });
    }

    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    // Bulk import is bulk create — gate on the same ITEM_CREATE access the
    // single-item POST uses (plus any in_project deny policy).
    await requireAccess(ctx, "ITEM_CREATE", {
      createdById: ctx.userId,
      projectId,
    });

    // The project must belong to this org.
    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
      select: { id: true },
    });
    if (!project) return new Response("Project not found", { status: 404 });

    const body = await request.json();
    const req = importSchema.parse(body) as ImportRequest;

    const report = await runImport(
      { orgId, projectId, userId: ctx.userId },
      req,
    );
    return success(report);
  } catch (err) {
    return handleApiError(err);
  }
}
