import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { FeedbackAutomationForm } from "@/components/settings/feedback-automation-form";
import { IntakePolicyForm } from "@/components/settings/intake-policy-form";
import { Lock } from "lucide-react";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function FeedbackAutomationPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const canManage = hasPermission(ctx.permissions, Permission.ORG_UPDATE);

  return (
    <PageShell
      title="Feedback Automation"
      description="Auto-triage new feature requests and bug reports into your work backlog."
    >
      {canManage ? (
        <div className="space-y-6">
          <FeedbackAutomationForm orgId={ctx.orgId} />
          <IntakePolicyForm orgId={ctx.orgId} />
        </div>
      ) : (
        <EmptyState
          illustration={<Lock className="mx-auto h-12 w-12 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden />}
          title="No access"
          description="You need organization-admin permission to configure feedback automation."
        />
      )}
    </PageShell>
  );
}
