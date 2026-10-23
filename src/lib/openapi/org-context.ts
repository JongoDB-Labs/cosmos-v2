import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { ProblemError } from "./problem";

/**
 * The prelude every org route repeats: resolve the org from the path's UUID,
 * then the caller (session cookie or bearer token) within it. Throws problems
 * (404, then 401) for the route's catch to answer.
 */
export async function orgContext(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new ProblemError(404, "not_found", "Organization not found");
  const ctx = await getAuthContext(org.slug);
  if (!ctx) throw new ProblemError(401, "unauthorized");
  return { org, ctx };
}
