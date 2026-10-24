import { NextRequest } from "next/server";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { listLabels } from "./route.contract";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { resolveLabels } from "@/lib/work-items/labels";
import { z } from "zod";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";

const createLabelSchema = z.object({
  name: z.string().min(1).max(60),
  color: z.string().max(30).nullish(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * The org's label catalogue, with how many work items carry each.
 *
 * `?projectId=` narrows the COUNT to that project rather than the list — the
 * management UI needs "what does this org have" and "how much is it used over
 * here" at once, and dropping unused labels from the list would hide exactly
 * the ones an admin wants to clean up.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listLabels);
    const { params: { orgId }, query: { projectId } } = await parseRequest(listLabels, request, params);
    // ORG_READ for a session; a key's `read` scope deliberately lacks it (see
    // SCOPE_MASK in lib/auth/api-key.ts), so a key reads this with PROJECT_READ.
    requirePermission(ctx, ctx.isApiKey ? Permission.PROJECT_READ : Permission.ORG_READ);

    const labels = await prisma.label.findMany({
      where: { orgId },
      orderBy: { name: "asc" },
    });

    // A key counts only items in projects it can read (its projectScope and
    // team scoping). A session keeps the org-wide counts it has always had.
    const readable = ctx.isApiKey ? await getReadableProjectIds(ctx) : null;
    const counted = readable ? (projectId ? readable.filter((id) => id === projectId) : readable) : null;
    const counts = await prisma.workItemLabel.groupBy({
      by: ["labelId"],
      where: {
        orgId,
        ...(counted ? { workItem: { projectId: { in: counted } } } : projectId ? { workItem: { projectId } } : {}),
      },
      _count: { _all: true },
    });
    const countById = new Map(counts.map((c) => [c.labelId, c._count._all]));

    return respond(
      listLabels,
      200,
      labels.map((l) => ({ ...l, itemCount: countById.get(l.id) ?? 0 })),
    );
  } catch (error) {
    return handleApiError(error, request);
  }
}

/**
 * Create a label.
 *
 * Gated on ITEM_UPDATE rather than an admin permission: naming a new label is
 * part of ordinary tagging, and requiring an admin would push people straight
 * back to typing free-text. Renaming and deleting are the org-wide operations,
 * and those are admin-gated on the [labelId] route.
 *
 * Returns the EXISTING row when the name already exists in any casing — the
 * point of the catalogue is that an org has one "Security", so asking for it
 * twice is a no-op, not a conflict the caller has to handle.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return problem(404, "not_found", undefined, { request });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return problem(401, "unauthorized", undefined, { request });
    requirePermission(ctx, Permission.ITEM_UPDATE);

    const data = createLabelSchema.parse(await request.json());

    const [label] = await resolveLabels(prisma, orgId, [data.name]);
    if (!label) {
      return problem(400, "invalid_request", "Label name is empty", { request });
    }

    if (data.color !== undefined && data.color !== null) {
      await prisma.label.update({
        where: { id: label.id },
        data: { color: data.color },
      });
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "label.create",
      entity: "label",
      entityId: label.id,
      metadata: { name: label.name },
      ipAddress: getIpAddress(request),
    });

    return created(await prisma.label.findUniqueOrThrow({ where: { id: label.id } }));
  } catch (error) {
    return handleApiError(error, request);
  }
}
