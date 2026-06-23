import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { RolesManager } from "@/components/settings/roles-manager";
import { PageShell } from "@/components/ui/page-shell";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { NoAccess } from "@/components/settings/no-access";

type PageParams = { params: Promise<{ orgSlug: string }> };

// No server prefetch here: WorkRole.grants is a BigInt and would throw on
// dehydrate/JSON.stringify. The client fetches the DTO (grants as permission
// keys) from /work-roles on mount.
export default async function RolesPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  if (!canViewSettings(ctx, "/settings/roles")) {
    return (
      <PageShell
        title="Roles & Access"
        description="Work roles grant extra permissions on top of a member's org role"
      >
        <NoAccess what="roles & access" />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Roles & Access"
      description="Work roles grant extra permissions on top of a member's org role"
    >
      <RolesManager orgId={ctx.orgId} />
    </PageShell>
  );
}
