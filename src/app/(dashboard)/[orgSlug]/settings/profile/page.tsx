import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getAuthContext, getCurrentUser } from "@/lib/auth/session";
import { PageShell } from "@/components/ui/page-shell";
import { ProfileForm } from "./profile-form";
import { ClaudeAccountPanel } from "@/components/settings/claude-account-panel";
import { SlackNotificationsSection } from "@/components/settings/slack-notifications";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function ProfileSettingsPage({ params }: PageParams) {
  // Profile data isn't per org, but Slack links are: the org comes from the URL.
  const { orgSlug } = await params;
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/login");
  const ctx = await getAuthContext(orgSlug);

  const user = await prisma.user.findUnique({
    where: { id: currentUser.id },
    select: { id: true, email: true, displayName: true, avatarUrl: true },
  });
  if (!user) redirect("/login");

  return (
    <PageShell title="Profile" description="Your account details" maxWidth="5xl">
      <div className="space-y-6">
        <ProfileForm initial={user} />
        <ClaudeAccountPanel />
        {ctx && <SlackNotificationsSection orgId={ctx.orgId} />}
      </div>
    </PageShell>
  );
}
