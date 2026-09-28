import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { TimeTracker } from "@/components/time-tracking/time-tracker";
import { PageShell } from "@/components/ui/page-shell";
import Link from "next/link";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function TimeTrackingPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell
      title="Time tracking"
      description="Log and review time entries"
      maxWidth="7xl"
      actions={
        <div className="flex items-center gap-2">
          <Link
            href={`/${orgSlug}/time-tracking/time-off`}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            Time off
          </Link>
          <Link
            href={`/${orgSlug}/time-tracking/past`}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            Past timesheets
          </Link>
        </div>
      }
    >
      <TimeTracker orgId={ctx.orgId} />
    </PageShell>
  );
}
