import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { API_KEY_SCOPES, mintApiKey } from "@/lib/auth/api-key";

type RouteParams = { params: Promise<{ orgId: string }> };

const createSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  expiresAt: z.string().datetime().nullish(),
});

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.API_KEY_MANAGE);

    // NEVER select `keyHash` — only its sealed sha256 lives in the DB, but it
    // still must not leak to the client.
    return success(
      await prisma.apiKey.findMany({
        where: { orgId },
        select: {
          id: true,
          name: true,
          prefix: true,
          scopes: true,
          expiresAt: true,
          lastUsed: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    // Keys are minted by humans in the UI (session auth), not by other keys.
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.API_KEY_MANAGE);

    const { name, scopes, expiresAt } = createSchema.parse(await request.json());

    const result = await mintApiKey({
      orgId,
      name,
      scopes,
      createdById: ctx.userId,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });

    // The plaintext `token` is returned exactly once — here — and never again.
    return created({ ...result.record, token: result.token });
  } catch (e) {
    return handleApiError(e);
  }
}
