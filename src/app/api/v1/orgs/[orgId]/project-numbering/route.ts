import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { problem } from "@/lib/openapi/problem";
import {
  projectNumbering,
  validatePattern,
  validateNamePattern,
  MAX_PATTERN_LENGTH,
} from "@/lib/projects/numbering";
import { allocateProjectNumber } from "@/lib/projects/numbering.server";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * The org's project numbering standard (src/lib/projects/numbering.ts).
 *
 * GET  the standard, the next number it would give, and whether the caller
 *      may change it — for anyone who reads projects (the New project form).
 * PUT  a partial update with ORG_MANAGE_SETTINGS; audited. Existing project
 *      numbers are never rewritten.
 */
async function load(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, settings: true } });
  if (!org) return { org: null, ctx: null };
  return { org, ctx: await getAuthContext(org.slug) };
}

const putSchema = z.strictObject({
  pattern: z.string().trim().max(MAX_PATTERN_LENGTH).nullable().optional(),
  namePattern: z.string().trim().max(60).nullable().optional(),
});

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await load((await params).orgId);
    if (!org) return new Response("Not found", { status: 404 });
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);
    const numbering = projectNumbering(org.settings);
    return success({
      ...numbering,
      next: numbering.pattern ? await allocateProjectNumber(prisma, org.id, numbering.pattern) : null,
      canManage: hasPermission(ctx.permissions, Permission.ORG_MANAGE_SETTINGS),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await load((await params).orgId);
    if (!org) return new Response("Not found", { status: 404 });
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);

    const body = putSchema.parse(await request.json());
    // "" from a cleared field means off, the same as null.
    const patch: Record<string, string | null> = {};
    if (body.pattern !== undefined) patch.pattern = body.pattern || null;
    if (body.namePattern !== undefined) patch.namePattern = body.namePattern || null;
    const invalid =
      (patch.pattern && validatePattern(patch.pattern)) || (patch.namePattern && validateNamePattern(patch.namePattern));
    if (invalid) return problem(400, "invalid_request", invalid, { request });

    const before = projectNumbering(org.settings);
    // Merged in one statement, so a concurrent change to any other org setting
    // is not overwritten by a stale read.
    const [row] = await prisma.$queryRaw<{ settings: unknown }[]>`
      UPDATE organizations
      SET settings = jsonb_set(
        jsonb_set(COALESCE(settings, '{}'::jsonb), '{projects}', COALESCE(settings->'projects', '{}'::jsonb)),
        '{projects,numbering}',
        COALESCE(settings->'projects'->'numbering', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
      )
      WHERE id = ${org.id}::uuid
      RETURNING settings
    `;
    const after = projectNumbering(row?.settings);
    await logAudit({
      orgId: org.id,
      userId: ctx.userId,
      action: "project.numbering_updated",
      entity: "organization",
      entityId: org.id,
      metadata: {
        pattern: `${before.pattern ?? "off"} -> ${after.pattern ?? "off"}`,
        namePattern: `${before.namePattern ?? "off"} -> ${after.namePattern ?? "off"}`,
      },
      ipAddress: getIpAddress(request),
    });
    return success({
      ...after,
      next: after.pattern ? await allocateProjectNumber(prisma, org.id, after.pattern) : null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
