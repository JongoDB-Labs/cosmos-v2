import { NextRequest } from "next/server";
import { GET as searchGet } from "./search/route";

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
 * A delegation, not a copy: same handler, same filter parsing, same RBAC
 * scoping through `getReadableProjectIds`. `/search` keeps working — it is used
 * by the Issues view and carries the POST body form for complex filters — so
 * this adds a name for something rather than a second implementation of it.
 */
export async function GET(request: NextRequest, ctx: RouteParams) {
  return searchGet(request, ctx);
}
