import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { TimeOff } from "@/components/time-tracking/time-off";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function TimeOffPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell
      tourAnchor="time-off"
      title="Time off"
      description="Ask to be away, and answer the people who have asked you"
      maxWidth="7xl"
    >
      <TimeOff orgId={ctx.orgId} />
    </PageShell>
  );
}
