import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { AnalyticsDashboard } from "@/components/analytics/analytics-dashboard";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function AnalyticsPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell title="Analytics" description="Portfolio insights" maxWidth="7xl">
      <AnalyticsDashboard orgId={ctx.orgId} />
    </PageShell>
  );
}
