import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import {
  connectForemanGithub,
  disconnectForemanGithub,
  getForemanGithubStatus,
  validateGithubPat,
} from "@/lib/ai/foreman-github-pat";

/**
 * Foreman's per-org GitHub PAT connection (fine-grained token). Mirrors the
 * foreman/claude-subscription routes: GET status, POST connect (validate+seal),
 * DELETE disconnect. Gated by ORG_MANAGE_SETTINGS. The token is validated live
 * before it is sealed, and never returned to the client.
 */
type RouteParams = { params: Promise<{ orgId: string }> };

async function gate(
  params: RouteParams["params"],
): Promise<{ orgId: string } | { error: Response }> {
  const { orgId } = await params;
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true },
  });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);
  return { orgId };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const g = await gate(params);
    if ("error" in g) return g.error;
    return success(await getForemanGithubStatus(g.orgId));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const g = await gate(params);
    if ("error" in g) return g.error;
    const body = (await request.json().catch(() => ({}))) as { token?: unknown };
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return new Response("Missing token", { status: 400 });
    const v = await validateGithubPat(token);
    if (!v) {
      return new Response(
        "GitHub rejected that token. Check it is a valid fine-grained PAT with read access to the repository.",
        { status: 422 },
      );
    }
    await connectForemanGithub(g.orgId, token, v.login);
    return success({ connected: true, login: v.login });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const g = await gate(params);
    if ("error" in g) return g.error;
    await disconnectForemanGithub(g.orgId);
    return success({ connected: false });
  } catch (error) {
    return handleApiError(error);
  }
}
