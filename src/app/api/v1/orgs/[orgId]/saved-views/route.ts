import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, created } from "@/lib/api-helpers";
import { createSavedView, listSavedViews } from "@/lib/query/saved-view-service.server";
import { savedViewErrorResponse } from "@/lib/query/saved-view-response.server";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Saved filters (query design §10): named, reusable Issues queries.
 *
 * GET lists the filters the caller can see (their own, ones they co-edit, and
 * ones shared with a team, project or the org they belong to), with their
 * star; `?projectId=` narrows to the filters shared with that project. Orgs without CQL keep #1093's rule: a filter someone else shared that
 * names something the caller can't read isn't listed. With CQL it is listed,
 * and GET /saved-views/:id shows its text with those parts ‹restricted›.
 *
 * POST saves one. With CQL the query is validated and stored resolved (ids);
 * the legacy `filter` is written alongside while it can say the query.
 *
 * The gates and writes live in `saved-view-service.server.ts`, shared with the
 * assistant's saved-view tools.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    // `?projectId=`: the filters shared with that project (its "Filters" tab).
    const projectId = request.nextUrl.searchParams.get("projectId");
    return success(await listSavedViews(ctx, org, { projectId }));
  } catch (error) {
    return savedViewErrorResponse(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    return created(await createSavedView(ctx, org, () => request.json()));
  } catch (error) {
    return savedViewErrorResponse(error);
  }
}
