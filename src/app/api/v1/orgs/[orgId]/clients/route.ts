import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

/**
 * Clients the practice delivers for.
 *
 * Separate from CRM contacts on purpose: a CrmContact is a sales PROSPECT with
 * a pipeline stage and a deal value, whereas this is the organisation a project
 * is run and invoiced for. Reusing the CRM record would put won work back on
 * the pipeline board.
 *
 * Read is gated on PROJECT_READ rather than a client-specific bit: the client
 * is part of a project's identity, and anyone who can see the project already
 * sees the client's name on it.
 */

type RouteParams = { params: Promise<{ orgId: string }> };

const createSchema = z.object({
  name: z.string().min(1).max(200),
  legalName: z.string().max(200).nullish(),
  email: z.string().email().max(320).nullish(),
  phone: z.string().max(60).nullish(),
  website: z.string().max(300).nullish(),
  notes: z.string().max(10000).nullish(),
  active: z.boolean().optional(),
});

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    // Inactive clients are excluded by default but reachable, because a former
    // client still owns its history and sometimes needs to be picked again.
    const includeInactive = request.nextUrl.searchParams.get("includeInactive") === "true";

    const clients = await prisma.client.findMany({
      where: { orgId, ...(includeInactive ? {} : { active: true }) },
      orderBy: { name: "asc" },
      select: {
        id: true, name: true, legalName: true, email: true, phone: true,
        website: true, notes: true, active: true,
        _count: { select: { projects: true } },
      },
    });

    return success(
      clients.map(({ _count, ...c }) => ({ ...c, projectCount: _count.projects })),
    );
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const data = createSchema.parse(await request.json());
    const name = data.name.replace(/\s+/g, " ").trim();

    try {
      const client = await prisma.client.create({
        data: {
          orgId,
          name,
          legalName: data.legalName ?? null,
          email: data.email ?? null,
          phone: data.phone ?? null,
          website: data.website ?? null,
          notes: data.notes ?? null,
          active: data.active ?? true,
        },
        select: { id: true, name: true, active: true },
      });
      return success(client);
    } catch (e) {
      // A duplicate name is a normal thing for a user to do — two people adding
      // the same client from different projects — so it answers with the row
      // that already exists rather than an error the caller has to interpret.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const existing = await prisma.client.findFirst({
          where: { orgId, name },
          select: { id: true, name: true, active: true },
        });
        if (existing) return success(existing);
      }
      throw e;
    }
  } catch (error) {
    return handleApiError(error);
  }
}
