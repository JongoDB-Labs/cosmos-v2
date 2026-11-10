import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requirePermission } from "@/lib/rbac/check";
import { orgContext } from "@/lib/openapi/org-context";
import { listEventCategories as listContract, createEventCategory as createContract } from "./route.contract";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { listCategories, categoryCounts } from "@/lib/program-calendar/service";

type RouteParams = { params: Promise<{ orgId: string }> };

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Space-separated rgb channels — the chip tint is mixed from these at render
  // time rather than stored as a finished colour, so it can composite over
  // either theme's surface.
  tintRgb: z.string().regex(/^\d{1,3} \d{1,3} \d{1,3}$/),
  tintAlpha: z.number().min(0.05).max(1).default(0.2),
  textColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
});

/** The org's categories, with counts for the window when one is given.
 *  Seeds the nine defaults the first time an org asks. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    // orgContext runs assertScopes; getAuthContext alone does not, which would
    // leave this contract's `scopes: []` unenforced against API keys.
    const { ctx } = await orgContext(orgId, listContract);
    requirePermission(ctx, Permission.BOARD_READ);

    const categories = await listCategories(orgId);
    const from = request.nextUrl.searchParams.get("from");
    const to = request.nextUrl.searchParams.get("to");
    const counts =
      from && to ? await categoryCounts(ctx, new Date(from), new Date(to)) : {};

    return success(categories.map((c) => ({ ...c, count: counts[c.id] ?? 0 })));
  } catch (error) {
    return handleApiError(error);
  }
}

/** Adding a category changes what every member of the org sees, so it takes
 *  the settings permission rather than the board one. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { ctx } = await orgContext(orgId, createContract);
    requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);

    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response("Bad request", { status: 400 });

    const last = await prisma.eventCategory.findFirst({
      where: { orgId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });

    const created = await prisma.eventCategory.create({
      data: { ...parsed.data, orgId, sortOrder: (last?.sortOrder ?? -1) + 1 },
    });
    return success(created, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
