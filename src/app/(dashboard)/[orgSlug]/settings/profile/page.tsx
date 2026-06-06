import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { PageShell } from "@/components/ui/page-shell";
import { ProfileForm } from "./profile-form";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function ProfileSettingsPage({ params }: PageParams) {
  // We don't actually need orgSlug for profile data, but the route is org-scoped
  // for URL consistency. Validate the user is auth'd.
  await params;
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: currentUser.id },
    select: { id: true, email: true, displayName: true, avatarUrl: true },
  });
  if (!user) redirect("/login");

  return (
    <PageShell title="Profile" description="Your account details" maxWidth="5xl">
      <ProfileForm initial={user} />
    </PageShell>
  );
}
