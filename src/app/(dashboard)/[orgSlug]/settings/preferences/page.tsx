import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { PreferencesForm } from "@/components/settings/preferences-form";
import { PageShell } from "@/components/ui/page-shell";

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
    </PageShell>
  );
}
