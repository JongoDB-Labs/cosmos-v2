import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { ProblemError } from "@/lib/openapi/problem";

/**
 * Editing one client.
 *
 * Until this existed a client could be created (POST on the collection) and
 * never corrected: a typo in a name, a changed phone number or a client gone
 * quiet stayed exactly as first entered, because nothing could write the row.
 *
 * Gated like its CRM siblings: CRM_UPDATE to write. The row must belong to the
 * org in the URL — a client id from another org is a 404, the same answer as
 * an id that does not exist, so the route says nothing about other tenants.
 */

type RouteParams = { params: Promise<{ orgId: string; clientId: string }> };

// `undefined` leaves a field alone; `null` clears an optional one. The name is
// required on the row, so it can be changed but never cleared.
const updateSchema = z
  .object({
    name: z.string().min(1).max(200),
    legalName: z.string().max(200).nullable(),
    email: z.string().email().max(320).nullable(),
    phone: z.string().max(60).nullable(),
    website: z.string().max(300).nullable(),
    notes: z.string().max(10000).nullable(),
    active: z.boolean(),
  })
  .partial()
  .strict();

const SELECT = {
  id: true, name: true, legalName: true, email: true, phone: true,
  website: true, notes: true, active: true,
} as const;

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_UPDATE);

    const data = updateSchema.parse(await request.json());

    const existing = await prisma.client.findFirst({ where: { id: clientId, orgId }, select: { id: true } });
    if (!existing) return new Response("Not found", { status: 404 });

    // Same normalisation as create, so "Acme  Corp" and "Acme Corp" stay one
    // client under the (orgId, name) unique key.
    const patch = data.name === undefined ? data : { ...data, name: data.name.replace(/\s+/g, " ").trim() };
    if (patch.name === "") throw new ProblemError(400, "invalid_request", "A client needs a name.");

    let updated;
    try {
      updated = await prisma.client.update({ where: { id: clientId }, data: patch, select: SELECT });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ProblemError(409, "conflict", "Another client already has that name.");
      }
      throw e;
    }

    // Field NAMES only: the values are contact details, which the audit log
    // has no reason to hold a second copy of.
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "client.updated",
      entity: "client",
      entityId: clientId,
      metadata: { changes: Object.keys(patch).join(", ") },
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
