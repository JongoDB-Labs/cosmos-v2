import { NextRequest } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/rbac/check";
import { orgContext } from "@/lib/openapi/org-context";
import {
  getProgramEvent as getContract,
  updateProgramEvent as updateContract,
  deleteProgramEvent as deleteContract,
} from "./route.contract";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { EventRecurrence } from "@prisma/client";
import { updateProgramEvent, deleteProgramEvent, visibleEvent } from "@/lib/program-calendar/service";

type RouteParams = { params: Promise<{ orgId: string; eventId: string }> };

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

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, eventId } = await params;
    // orgContext is the only path that runs assertScopes — see the collection
    // route for why calling getAuthContext directly leaves `scopes: []` unenforced.
    const { ctx } = await orgContext(orgId, getContract);
    requirePermission(ctx, Permission.BOARD_READ);

    const ev = await visibleEvent(ctx, eventId);
    // 404 rather than 403 for an event on a project they cannot see: the same
    // answer a missing id gives, so the response does not confirm it exists.
    if (!ev) return new Response("Not found", { status: 404 });
    return success(ev);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, eventId } = await params;
    const { ctx } = await orgContext(orgId, updateContract);
    requirePermission(ctx, Permission.BOARD_UPDATE);

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response("Bad request", { status: 400 });

    const updated = await updateProgramEvent(ctx, eventId, {
      ...parsed.data,
      startsAt: new Date(parsed.data.startsAt),
      endsAt: new Date(parsed.data.endsAt),
    });
    if (!updated) return new Response("Not found", { status: 404 });
    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, eventId } = await params;
    const { ctx } = await orgContext(orgId, deleteContract);
    requirePermission(ctx, Permission.BOARD_UPDATE);

    const ok = await deleteProgramEvent(ctx, eventId);
    if (!ok) return new Response("Not found", { status: 404 });
    return success({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
