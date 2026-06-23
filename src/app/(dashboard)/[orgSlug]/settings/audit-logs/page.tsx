import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { AuditLogViewer } from "@/components/security/audit-log-viewer";
import { PageShell } from "@/components/ui/page-shell";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { NoAccess } from "@/components/settings/no-access";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function AuditLogsPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  if (!canViewSettings(ctx, "/settings/audit-logs")) {
    return (
      <PageShell
        title="Audit logs"
        description="Activity history for this organization"
      >
        <NoAccess what="audit logs" />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Audit logs"
      description="Activity history for this organization"
    >
      <AuditLogViewer orgId={ctx.orgId} />
    </PageShell>
  );
}
