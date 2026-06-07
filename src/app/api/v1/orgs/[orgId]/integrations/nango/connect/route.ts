import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { createConnectSession, nangoEnabled } from "@/lib/integrations/nango";

/**
 * POST /api/v1/orgs/[orgId]/integrations/nango/connect
 *
 * Create a Nango Connect session so an org admin can grant a COMMERCIAL SaaS
 * connection (OAuth or API-key) for a provider. Returns the session token the
 * frontend Connect UI uses. The full OAuth round-trip needs real provider creds and
 * is out of scope here — this route creates the SESSION only.
 *
 * ── D5 GOV-BLOCK, LAYER 4 (the connect ROUTE refuses for a gov org) ──────────────
 * Nango is COMMERCIAL-ONLY. A gov org can NEVER obtain a Nango connection: this route
 * returns 403 for any org whose tenantClass is not COMMERCIAL (fail-closed — GOV is
 * the default). The refusal is AUDITED. This is the network-edge layer; the model
 * never sees the tools (L1), dispatch refuses (L2), and the executor hard-blocks (L3).
 *
 * Perm: INTEGRATION_MANAGE (admin-only — connecting an external SaaS is an org-admin
 * action, like installing any integration).
 */

const connectSchema = z.object({
  // The Nango integration id / provider config key (e.g. "hubspot", "salesforce").
  provider: z.string().min(1).max(100),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);

    // ── L4: gov-org refusal (403) ────────────────────────────────────────────────
    // Fail closed: only an explicit COMMERCIAL org may connect a Nango provider. A
    // gov (or any non-commercial) org is refused BEFORE any Nango call — audited.
    if (org.tenantClass !== "COMMERCIAL") {
      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "integration.nango.connect.denied_gov",
        entity: "integration",
        metadata: { reason: "commercial-only (D5)", tenantClass: org.tenantClass } as Record<string, string>,
        ipAddress: getIpAddress(request),
      });
      return NextResponse.json(
        { error: "The unified-connector engine (Nango) is commercial-only and is not available to this organization." },
        { status: 403 },
      );
    }

    if (!nangoEnabled()) {
      return NextResponse.json(
        { error: "Nango is not configured for this deployment. An operator must start the `nango` profile and set NANGO_SECRET_KEY / NANGO_HOST." },
        { status: 503 },
      );
    }

    const body = await request.json();
    const data = connectSchema.parse(body);

    const session = await createConnectSession(orgId, data.provider);
    // A graceful wrapper error (not-configured / not-connected) surfaces as a 502 — the
    // route itself succeeded but the broker couldn't fulfil it.
    if (session && typeof session === "object" && "error" in (session as Record<string, unknown>)) {
      return NextResponse.json(session, { status: 502 });
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "integration.nango.connect.session_created",
      entity: "integration",
      metadata: { provider: data.provider } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(session);
  } catch (error) {
    return handleApiError(error);
  }
}
