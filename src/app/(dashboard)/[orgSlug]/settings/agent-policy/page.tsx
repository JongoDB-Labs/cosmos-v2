import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/session";
import { PageShell } from "@/components/ui/page-shell";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { AgentPolicyPanel } from "@/components/settings/agent-policy-panel";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { NoAccess } from "@/components/settings/no-access";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Agent Policy (design D9/§8) — the GUI surface for the MIDDLE gate of
 * RBAC ∩ AgentPolicy ∩ Classification: which tools/domains the AI agent may call + arg bounds.
 *
 * Cache Components: `await params` + the cookie read (getAuthContext) live INSIDE the
 * <Suspense> boundary (<Gate>), so the static shell ships immediately and the dynamic auth
 * read is suspended (mirrors the runtime-config page). THIN: the API is the source of truth;
 * the panel just GET/PATCHes the agent-policy route. Gated by AGENT_POLICY_MANAGE.
 */
export default function AgentPolicyPage({ params }: PageParams) {
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

  // Tenant-admin gate (the panel mirrors the route's AGENT_POLICY_MANAGE check).
  if (!canViewSettings(ctx, "/settings/agent-policy")) {
    return (
      <PageShell title="Agent policy" description="What the AI agent may do">
        <NoAccess what="agent policy" />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Agent policy"
      description="The middle authorization gate for the AI agent — block tools or data domains, and bound result sizes and project scope per tool call. No policy means everything is allowed."
    >
      <AgentPolicyPanel orgId={ctx.orgId} />
    </PageShell>
  );
}
