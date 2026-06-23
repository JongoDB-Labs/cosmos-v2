import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/session";
import { PageShell } from "@/components/ui/page-shell";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { AgentGovernanceDashboard } from "@/components/settings/agent-governance-dashboard";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { NoAccess } from "@/components/settings/no-access";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Agent Governance / Egress-Audit (AC-4 evidence + AU-6 audit review) — the gov "control
 * posture at a glance" surface. A READ-ONLY dashboard that makes the CUI-blind agent posture
 * VISIBLE + AUDITABLE: egress-decision aggregates (the chokepoint working), recent structural
 * activity, the audit-chain integrity status, and the active governance posture.
 *
 * Cache Components: `await params` + the cookie read (getAuthContext) live INSIDE the
 * <Suspense> boundary (<Gate>), so the static shell ships immediately and the dynamic auth
 * read is suspended (mirrors the runtime-config + agent-policy pages). The dynamic governance
 * data is fetched CLIENT-SIDE via useQuery against the API — no dynamic reads at module scope.
 * Gated by SECURITY_MANAGE (the same gate as the route). NO CUI is ever surfaced.
 */
export default function AgentGovernancePage({ params }: PageParams) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Gate params={params} />
    </Suspense>
  );
}

async function Gate({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // Security-admin gate (the dashboard mirrors the route's SECURITY_MANAGE check).
  if (!canViewSettings(ctx, "/settings/agent-governance")) {
    return (
      <PageShell title="Agent governance" description="Egress-audit & control posture">
        <NoAccess what="agent governance" />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Agent governance"
      description="The CUI-blind agent posture made visible and auditable — egress decisions, audit-chain integrity, and the active governance posture. Read-only; no message content is ever surfaced."
    >
      <AgentGovernanceDashboard orgId={ctx.orgId} orgSlug={orgSlug} />
    </PageShell>
  );
}
