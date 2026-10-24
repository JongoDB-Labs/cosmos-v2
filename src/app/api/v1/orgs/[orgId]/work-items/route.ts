import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { orgContext } from "@/lib/openapi/org-context";
import { searchByParams } from "./search/route";
import { listWorkItems } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * `GET /api/v1/orgs/{orgId}/work-items` — the org-wide work-item collection.
 *
 * The collection already existed, at `/work-items/search`. Nothing pointed a
 * reader at it: a client following ordinary REST shape asks for the collection
 * at the collection's path, gets Next's HTML 404, and reasonably concludes the
 * resource does not exist — which is exactly the report this route answers. The
 * sibling paths (`/facets`, `/export`, `/{itemId}/row`) all hang off this one,
 * so the bare path being the only 404 in the family was the odd one out.
 *
 * A delegation, not a copy: same search, same filter parsing, same RBAC
 * scoping through `getReadableProjectIds`. `/search` keeps working — it is used
 * by the Issues view and carries the POST body form for complex filters — so
 * this adds a name for something rather than a second implementation of it.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await orgContext((await params).orgId, listWorkItems);
    const { params: { orgId } } = await parseRequest(listWorkItems, request, params);
    const result = await searchByParams(request, org, ctx, orgId);
    return result instanceof Response ? result : respond(listWorkItems, 200, result);
  } catch (error) {
    return handleApiError(error);
  }
}
