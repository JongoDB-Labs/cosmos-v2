import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { PastTimesheets } from "@/components/time-tracking/past-timesheets";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function PastTimesheetsPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell
      title="Past timesheets"
      description="Every period of the year, and what you submitted for it"
      maxWidth="7xl"
    >
      <PastTimesheets orgId={ctx.orgId} />
    </PageShell>
  );
}
