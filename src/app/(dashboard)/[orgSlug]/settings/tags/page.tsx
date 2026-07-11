import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { TagsManager } from "@/components/settings/tags-manager";
import { PageShell } from "@/components/ui/page-shell";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { NoAccess } from "@/components/settings/no-access";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function TagsSettingsPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const title = "Tags";
  const description = "Create and manage the tags you can assign to tasks";

  if (!canViewSettings(ctx, "/settings/tags")) {
    return (
      <PageShell title={title} description={description}>
        <NoAccess what="tags" />
      </PageShell>
    );
  }

  return (
    <PageShell title={title} description={description}>
      <TagsManager orgId={ctx.orgId} />
    </PageShell>
  );
}
