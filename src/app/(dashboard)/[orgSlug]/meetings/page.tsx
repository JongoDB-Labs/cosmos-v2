import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { MeetingsList } from "@/components/meetings/meetings-list";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function MeetingsPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell title="Meetings" description="Schedule and notes" maxWidth="7xl">
      <MeetingsList orgId={ctx.orgId} />
    </PageShell>
  );
}
