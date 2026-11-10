import { NextRequest } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/rbac/check";
import { orgContext } from "@/lib/openapi/org-context";
import { listProgramEvents as listContract, createProgramEvent as createContract } from "./route.contract";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { EventRecurrence } from "@prisma/client";
import { listProgramEvents, createProgramEvent, type EventFilters } from "@/lib/program-calendar/service";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Program events in a window.
 *
 * Gated on BOARD_READ / BOARD_UPDATE rather than a permission of its own. The
 * program calendar is a planning surface like any board, and minting a new
 * permission bit would leave every existing role without it until someone
 * re-granted by hand — a worse outcome than reusing the bit that already means
 * "may see the planning surfaces".
 *
 * Project visibility is NOT applied here: it lives in the service, so the list,
 * the counts and the by-id read cannot drift apart.
 */
const listQuery = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  categoryIds: z.string().optional(),
  ownerKeys: z.string().optional(),
  projectId: z.string().uuid().optional(),
  showOnDashboardOnly: z.enum(["true", "false"]).optional(),
  customerAttending: z.enum(["true", "false"]).optional(),
  hasDeliverable: z.enum(["true", "false"]).optional(),
});

const bodySchema = z.object({
  title: z.string().trim().min(1).max(300),
  categoryId: z.string().uuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  allDay: z.boolean().default(false),
  timeZone: z.string().max(100).optional(),
  location: z.string().max(500).nullish(),
  ownerTeamId: z.string().uuid().nullish(),
  ownerMemberId: z.string().uuid().nullish(),
  attendees: z.string().max(4000).optional(),
  recurrence: z.nativeEnum(EventRecurrence).optional(),
  deliverableId: z.string().uuid().nullish(),
  customerAttending: z.boolean().optional(),
  description: z.string().max(20000).optional(),
  showOnDashboard: z.boolean().optional(),
  projectId: z.string().uuid().nullish(),
});

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    // orgContext, not getAuthContext: it is the ONLY path that runs
    // assertScopes, and this contract declares `scopes: []` to refuse every
    // bearer token. Calling getAuthContext directly authenticates the key and
    // silently skips that check, leaving the contract's promise unenforced.
    const { ctx } = await orgContext(orgId, listContract);
    requirePermission(ctx, Permission.BOARD_READ);

    const q = listQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!q.success) return new Response("Bad request", { status: 400 });

    const csv = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
    const filters: EventFilters = {
      categoryIds: csv(q.data.categoryIds),
      ownerKeys: csv(q.data.ownerKeys),
      projectId: q.data.projectId,
      showOnDashboardOnly: q.data.showOnDashboardOnly === "true",
      customerAttending: q.data.customerAttending === "true",
      hasDeliverable: q.data.hasDeliverable === "true",
    };

    const rows = await listProgramEvents(ctx, new Date(q.data.from), new Date(q.data.to), filters);
    return success(rows);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { ctx } = await orgContext(orgId, createContract);
    requirePermission(ctx, Permission.BOARD_UPDATE);

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response("Bad request", { status: 400 });

    const created = await createProgramEvent(ctx, ctx.userId, {
      ...parsed.data,
      startsAt: new Date(parsed.data.startsAt),
      endsAt: new Date(parsed.data.endsAt),
    });
    return success(created, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
