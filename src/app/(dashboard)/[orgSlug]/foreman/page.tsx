import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { ForemanConsole } from "@/components/foreman/foreman-console";
import { Lock } from "lucide-react";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function ForemanPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const canManage = hasPermission(ctx.permissions, Permission.ORG_UPDATE);

  return (
    <PageShell
      title="Foreman"
      description="Autonomous delivery — live status, decisions, and controls. Comment on a parked ticket to give Foreman new instructions."
    >
      {canManage ? (
        <ForemanConsole orgId={ctx.orgId} />
      ) : (
        <EmptyState
          illustration={<Lock className="mx-auto h-12 w-12 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden />}
          title="No access"
          description="You need organization-admin permission to view the Foreman console."
        />
      )}
    </PageShell>
  );
}
