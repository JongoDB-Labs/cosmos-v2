import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { getIpAddress } from "@/lib/api-helpers";
import type { AuthContext } from "@/lib/rbac/check";
import type { CeremonyCaller } from "@/lib/intervals/ceremony.server";

/**
 * The HTTP half of the ceremony routes: which org, and who is calling.
 *
 * Everything after that, the gates included, lives in
 * lib/intervals/ceremony.server.ts, which the assistant's ceremony tools call
 * too. A route resolves the caller here and hands the AuthContext over.
 */

export function isResponse(v: unknown): v is Response {
  return v instanceof Response;
}

/** Resolve the org and the caller's session or key, or the Response refusing them. */
export async function ceremonyAuth(orgId: string): Promise<AuthContext | Response> {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return new Response("Not found", { status: 404 });

  const ctx = await getAuthContext(org.slug);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  return ctx;
}

/** How a ceremony ROUTE calls the shared work. */
export function routeCaller(request: Request): CeremonyCaller {
  return { source: "API", ipAddress: getIpAddress(request) };
}
