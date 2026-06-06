import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { ThemePicker } from "@/components/ui/theme-picker";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function ThemesSettingsPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const org = await prisma.organization.findUnique({
    where: { id: ctx.orgId },
    select: { id: true, themePrimary: true, themeMode: true, logoUrl: true },
  });

  return (
    <PageShell title="Themes" description="Branding and primary color">
      <ThemePicker
        orgId={org!.id}
        initial={{
          themePrimary: org!.themePrimary,
          themeMode: org!.themeMode,
          logoUrl: org!.logoUrl,
        }}
      />
    </PageShell>
  );
}
