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
  /** Projects the key may touch. Omitted or empty = org-wide. Capped so a
   *  caller cannot post an unbounded array. */
  projectIds: z.array(z.string().uuid()).max(200).optional(),
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
          projectIds: true,
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

    const { name, scopes, projectIds, expiresAt } = createSchema.parse(
      await request.json(),
    );

    // Every named project must exist in THIS org. Without this a caller could
    // store another org's project id on a key — harmless today, because the
    // ceiling is intersected with projects already scoped to `ctx.orgId`, but
    // it would be a confusing thing to have written down and a sharp edge for
    // whoever reads the ceiling next.
    const scopedProjectIds = projectIds?.length
      ? (
          await prisma.project.findMany({
            where: { orgId, id: { in: projectIds } },
            select: { id: true },
          })
        ).map((p) => p.id)
      : [];
    if ((projectIds?.length ?? 0) > 0 && scopedProjectIds.length === 0) {
      // Naming only unknown projects means an empty ceiling, and an empty
      // ceiling reads as "org-wide" — the exact opposite of what was asked for.
      return new Response("None of those projects exist in this org", { status: 400 });
    }

    const result = await mintApiKey({
      orgId,
      name,
      scopes,
      projectIds: scopedProjectIds,
      createdById: ctx.userId,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });

    // The plaintext `token` is returned exactly once — here — and never again.
    return created({ ...result.record, token: result.token });
  } catch (e) {
    return handleApiError(e);
  }
}
