import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { PreferencesForm } from "@/components/settings/preferences-form";
import { PageShell } from "@/components/ui/page-shell";
import { OutlookCalendarSection } from "@/components/settings/outlook-calendar";
import { CalendarFeedsSection } from "@/components/settings/calendar-feeds";
import { TeamsNotificationsSection } from "@/components/settings/teams-notifications";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function PreferencesPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell title="Preferences" description="General workspace settings">
      <PreferencesForm orgId={ctx.orgId} />
      <CalendarFeedsSection orgId={ctx.orgId} />
      <OutlookCalendarSection orgId={ctx.orgId} />
      <TeamsNotificationsSection orgId={ctx.orgId} />
    </PageShell>
  );
}
