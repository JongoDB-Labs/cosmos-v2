import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext, getCurrentUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { SIGN_IN_METHODS } from "@/lib/auth/invite-credentials";
import {
  approveAccountRequest as approve,
  NotPending,
  DomainNowDisallowed,
} from "@/lib/auth/account-requests";
import { OrgRole } from "@prisma/client";

const bodySchema = z.object({
  // The admin's per-request choice: an invitation link, or a temporary
  // password. On an address that already has an account the service coerces
  // this to "oauth" and never sets a credential — see createOrgInvitation.
  signInMethod: z.enum(SIGN_IN_METHODS).default("oauth"),
  role: z.nativeEnum(OrgRole).default(OrgRole.MEMBER),
  mfaRequired: z.boolean().default(false),
});

type RouteParams = { params: Promise<{ orgId: string; requestId: string }> };

/**
 * Approve a request, minting the account through the one shared path.
 *
 * Work-roles are deliberately NOT accepted here. Assigning them requires
 * checking each against the approver's own permission ceiling, and an approval
 * screen is the wrong place to make that decision — the admin adjusts roles on
 * the member once they have joined.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, requestId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const actor = await getCurrentUser();

    const result = await approve({
      orgId,
      orgName: org.name,
      orgSlug: org.slug,
      requestId,
      signInMethod: body.signInMethod,
      role: body.role,
      mfaRequired: body.mfaRequired,
      actorUserId: ctx.userId,
      actorDisplayName: actor ? actor.displayName : null,
      origin: getPublicOrigin(request),
      ipAddress: getIpAddress(request),
    });

    // The temporary password is emailed and never returned — a plaintext
    // secret in an API response leaks into proxies, logs and history.
    return success(result);
  } catch (error) {
    if (error instanceof NotPending) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (error instanceof DomainNowDisallowed) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return handleApiError(error);
  }
}
