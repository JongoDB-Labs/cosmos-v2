import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission, ForbiddenError } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { sendAppEmail } from "@/lib/integrations/email-sender";
import { getBrand } from "@/lib/brand";

/**
 * Send a TEST transactional email to the CURRENT user (the org owner), via the
 * org's RESOLVED email config (per-org sealed Resend config → env → throw). OWNER-
 * only, gated exactly like the email-settings + tenant-class OWNER routes.
 *
 * Returns HTTP 200 with { ok: true } on success, or { ok: false, error } carrying
 * the provider error text when the send fails (e.g. Resend rejects the key/From, or
 * nothing is configured) — so the settings UI can show the reason inline. Auth
 * failures still surface as 401/403 via the gate / handleApiError.
 */

type RouteParams = { params: Promise<{ orgId: string }> };

export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);
    if (ctx.orgRole !== "OWNER") {
      throw new ForbiddenError("Only the organization owner can manage email delivery settings.");
    }

    const user = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { email: true },
    });
    if (!user?.email) {
      return success({ ok: false, error: "Your account has no email address to send a test to." });
    }

    const brand = getBrand().name;
    try {
      await sendAppEmail({
        to: user.email,
        subject: `${brand} email delivery test`,
        text: `This is a test message confirming that ${brand} transactional email delivery for your organization is configured and working.`,
        html: `<p>This is a test message confirming that <strong>${brand}</strong> transactional email delivery for your organization is configured and working.</p>`,
        orgId,
        // Verify the saved key even before Enabled is flipped on (test-only).
        includeDisabledOrgConfig: true,
      });
      return success({ ok: true });
    } catch (err) {
      // Surface the provider's error text (e.g. Resend's HTTP body) so the owner
      // can see WHY delivery failed — a failed test is not a 500, it's a result.
      return success({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to send the test email.",
      });
    }
  } catch (error) {
    return handleApiError(error);
  }
}
