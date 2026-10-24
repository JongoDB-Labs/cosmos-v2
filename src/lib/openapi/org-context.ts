import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { ProblemError } from "./problem";
import { Uuid } from "./schemas/common";

/**
 * The prelude every org route repeats: resolve the org from the path's UUID,
 * then the caller (session cookie or bearer token) within it. Throws problems
 * (400 for an id that isn't a UUID, 404, then 401) for the route's catch to answer.
 *
 * Routes call it FIRST, with the raw path param, and validate the rest of the
 * request (other path ids, query, body) after: a caller who can't authenticate
 * gets a 401, never a 400 that describes what a valid request would look like.
 */
export async function orgContext(orgId: string) {
  if (!Uuid.safeParse(orgId).success) throw new ProblemError(400, "invalid_request", "orgId must be a UUID");
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new ProblemError(404, "not_found", "Organization not found");
  const ctx = await getAuthContext(org.slug);
  if (!ctx) throw new ProblemError(401, "unauthorized");
  return { org, ctx };
}
