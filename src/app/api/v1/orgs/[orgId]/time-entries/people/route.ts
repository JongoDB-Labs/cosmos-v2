import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { readableTimePeople } from "@/lib/time/scope";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Whose time the caller may look at: themselves, plus anyone reporting to them,
 * plus everyone in the org for a TIME_READ_ALL holder.
 *
 * Backs the person picker on the time-tracking page. The page must show ONE
 * person at a time — its week grid sums every row it receives, so a mixed
 * response turns "your week total" into several people's hours added together.
 *
 * Deliberately NOT the members list: a supervisor offered every colleague would
 * pick one and get a 403. This returns exactly the set the read scope permits,
 * so every option in the picker works.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_READ);

    const data = await readableTimePeople(ctx);
    return success({ data, total: data.length });
  } catch (error) {
    return handleApiError(error);
  }
}
