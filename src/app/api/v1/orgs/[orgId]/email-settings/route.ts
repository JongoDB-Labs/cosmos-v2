import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission, ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { sealSecret } from "@/lib/crypto/vault";
import { hasSealedApiKey } from "@/lib/integrations/org-email-config";

/**
 * Per-org transactional-email (Resend) delivery settings — set by an org OWNER
 * instead of a server env var.
 *
 * OWNER-ONLY, gated EXACTLY like the tenant-class OWNER route: ORG_MANAGE_SETTINGS
 * is the base permission bar, and the explicit OWNER-role check is the real gate —
 * an ADMIN holds ORG_MANAGE_SETTINGS but must NOT manage email delivery.
 *
 *   GET → { provider, fromAddress, enabled, configured } — `configured` is a mere
 *         boolean; the sealed API key value is NEVER returned.
 *   PUT → upsert { provider?, apiKey?, fromAddress?, enabled? }. A non-empty
 *         `apiKey` is SEALED with the vault ({ sealed }) before storage; an
 *         omitted/empty `apiKey` leaves the existing sealed value untouched (so the
 *         other fields can be saved without re-entering the key). The key is never
 *         echoed back.
 */

type RouteParams = { params: Promise<{ orgId: string }> };

// A From header is either a bare address (foo@bar.com) or the display-name form
// (Name <foo@bar.com>). Loose on the display name; strict-ish on the address.
const BARE_EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const NAME_ADDR = /^.+<\s*[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+\s*>$/;
function looksLikeFromHeader(value: string): boolean {
  const t = value.trim();
  return BARE_EMAIL.test(t) || NAME_ADDR.test(t);
}

const putSchema = z.object({
  provider: z.string().trim().min(1).optional(),
  // Optional secret. A non-empty string is sealed + stored; an omitted/empty value
  // leaves the existing sealed key untouched. Never echoed back.
  apiKey: z.string().optional(),
  // Validated only when present; an empty string clears the stored From address.
  fromAddress: z
    .string()
    .trim()
    .refine((v) => v.length === 0 || looksLikeFromHeader(v), {
      message: 'From address must be an email or a "Name <email>" header.',
    })
    .optional(),
  enabled: z.boolean().optional(),
});

/** OWNER-only gate + org lookup, mirroring the tenant-class OWNER route. Returns a
 *  short-circuit Response for 404/401; throws ForbiddenError (→403) for a
 *  non-owner; otherwise yields the resolved auth context. */
async function requireOwner(
  orgId: string,
): Promise<{ ok: false; response: Response } | { ok: true; ctx: AuthContext }> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true },
  });
  if (!org) return { ok: false, response: new Response("Not found", { status: 404 }) };

  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { ok: false, response: new Response("Unauthorized", { status: 401 }) };

  requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);
  if (ctx.orgRole !== "OWNER") {
    throw new ForbiddenError("Only the organization owner can manage email delivery settings.");
  }
  return { ok: true, ctx };
}

async function readStatus(orgId: string) {
  const settings = await prisma.orgEmailSettings.findUnique({
    where: { orgId },
    select: { provider: true, fromAddress: true, enabled: true, apiKey: true },
  });
  return {
    provider: settings?.provider ?? "resend",
    fromAddress: settings?.fromAddress ?? null,
    enabled: settings?.enabled ?? false,
    // Booleans only — the sealed key value is never serialized to the client.
    configured: hasSealedApiKey(settings?.apiKey),
  };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const gate = await requireOwner(orgId);
    if (!gate.ok) return gate.response;

    return success(await readStatus(orgId));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const gate = await requireOwner(orgId);
    if (!gate.ok) return gate.response;
    const { ctx } = gate;

    const body = putSchema.parse(await request.json());

    // A bare inferred object (NOT Prisma.OrgEmailSettingsUpdateInput) spreads
    // cleanly into both upsert branches with the sealed { sealed } Json literal —
    // same reasoning as the foreman/ai-credentials sealed-column writes.
    const trimmedKey = body.apiKey?.trim();
    const data = {
      updatedById: ctx.userId,
      ...(body.provider !== undefined ? { provider: body.provider } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.fromAddress !== undefined
        ? { fromAddress: body.fromAddress.length === 0 ? null : body.fromAddress }
        : {}),
      // Seal + store only a non-empty key; otherwise leave any existing key as-is.
      ...(trimmedKey ? { apiKey: { sealed: sealSecret(trimmedKey) } } : {}),
    };

    await prisma.orgEmailSettings.upsert({
      where: { orgId },
      create: { orgId, ...data },
      update: data,
    });

    return success(await readStatus(orgId));
  } catch (error) {
    return handleApiError(error);
  }
}
