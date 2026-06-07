import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { egressSummary, recentDecisions, auditIntegrity } from "@/lib/governance/summary";
import { getAgentPolicy } from "@/lib/ai/policy";
import { getRuntimeConfig } from "@/lib/runtime-config";

// The AGENT GOVERNANCE / EGRESS-AUDIT read API (AC-4 evidence made reviewable + AU-6 audit
// review). A READ-ONLY admin surface gated by SECURITY_MANAGE (the closest existing
// security-admin read gate — no new perm invented). Returns:
//   - egress  : aggregates over the org's egress_decisions (total/exposed/withheld/rate +
//               breakdowns by decidedBy / ceiling / tenantClass) — the visible proof the
//               CUI-blind chokepoint is working;
//   - recent  : the latest N STRUCTURAL decision rows (NO contentHash, NO CUI);
//   - integrity: the in-DB hash-chain status (verify_audit_chain) + high-water marks;
//   - posture : the org's tenantClass + the active AgentPolicy + the runtime-config posture.
//
// NO CUI / NO message content is ever surfaced — egress_decisions carries only structural
// metadata, and we never join to any content table. Never returns OrgMember.permissions (no
// BigInt in the payload). `since` (ISO) optionally bounds the egress aggregation window.

type RouteParams = { params: Promise<{ orgId: string }> };

const RECENT_LIMIT = 25;

async function loadOrg(orgId: string) {
  return prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true, tenantClass: true },
  });
}

/** Parse an optional `since` query param (ISO timestamp). Invalid/absent ⇒ undefined (all time). */
function parseSince(request: NextRequest): Date | undefined {
  const raw = new URL(request.url).searchParams.get("since");
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await loadOrg(orgId);
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SECURITY_MANAGE);

    const since = parseSince(request);

    const [egress, recent, integrity, agentPolicy, runtimeConfig] = await Promise.all([
      egressSummary(orgId, since),
      recentDecisions(orgId, RECENT_LIMIT),
      auditIntegrity(),
      getAgentPolicy(orgId),
      getRuntimeConfig(orgId),
    ]);

    // No BigInt anywhere: summary helpers stringify `seq`; policy/config are plain shapes.
    return success({
      since: since ? since.toISOString() : null,
      egress,
      recent,
      integrity,
      posture: {
        tenantClass: org.tenantClass,
        agentPolicy,
        runtimeConfig,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
