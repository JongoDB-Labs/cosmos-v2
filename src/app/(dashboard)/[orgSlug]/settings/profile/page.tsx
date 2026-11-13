import { Suspense } from "react";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getAuthContext, getCurrentUser } from "@/lib/auth/session";
import { PageShell } from "@/components/ui/page-shell";
import { ProfileForm } from "./profile-form";
import { ClaudeAccountPanel } from "@/components/settings/claude-account-panel";
import { SlackNotificationsSection } from "@/components/settings/slack-notifications";
import { SignInMethods } from "@/components/settings/sign-in-methods";
import { connectSignInRefusal } from "@/lib/internal/access";
import { googleLoginConfigured } from "@/lib/auth/google-oauth";
import { getProviderConfig } from "@/lib/auth/provider-config";

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
  const [googleAvailable, microsoft] = await Promise.all([
    googleLoginConfigured().catch(() => false),
    getProviderConfig("microsoft").catch(() => null),
  ]);

  return (
    <PageShell title="Profile" description="Your account details" maxWidth="5xl">
      <div className="space-y-6">
        <ProfileForm initial={user} />
        <Suspense fallback={null}>
          <SignInMethods
            google={{ available: googleAvailable, connected: currentUser.googleBound }}
            microsoft={{ available: Boolean(microsoft?.enabled), connected: currentUser.microsoftBound }}
            connectRefusal={connectSignInRefusal(currentUser)}
            returnTo={`/${orgSlug}/settings/profile`}
          />
        </Suspense>
        <ClaudeAccountPanel />
        {ctx && <SlackNotificationsSection orgId={ctx.orgId} />}
      </div>
    </PageShell>
  );
}
