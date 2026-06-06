import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { TimeTracker } from "@/components/time-tracking/time-tracker";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function TimeTrackingPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell title="Time tracking" description="Log and review time entries" maxWidth="7xl">
      <TimeTracker orgId={ctx.orgId} />
    </PageShell>
  );
}
