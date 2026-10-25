import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { PageShell } from "@/components/ui/page-shell";
import { ProfileForm } from "./profile-form";
import { ClaudeAccountPanel } from "@/components/settings/claude-account-panel";
import { PersonalTokensPanel } from "@/components/settings/personal-tokens-panel";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function ProfileSettingsPage({ params }: PageParams) {
  // Profile data is the user's own; the org is for the personal tokens, which
  // are minted per organization.
  const { orgSlug } = await params;
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: currentUser.id },
    select: { id: true, email: true, displayName: true, avatarUrl: true },
  });
  if (!user) redirect("/login");

  const org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true, name: true, tenantClass: true },
  });

  return (
    <PageShell title="Profile" description="Your account details" maxWidth="5xl">
      <div className="space-y-6">
        <ProfileForm initial={user} />
        <ClaudeAccountPanel />
        {org && (
          <PersonalTokensPanel orgId={org.id} orgName={org.name} maxDays={org.tenantClass === "GOV" ? 30 : 90} />
        )}
      </div>
    </PageShell>
  );
}
