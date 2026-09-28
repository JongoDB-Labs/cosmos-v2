import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { canViewPage } from "@/lib/nav/page-access";
import { NoPageAccess } from "@/components/ui/no-page-access";
import { PageShell } from "@/components/ui/page-shell";
import { FirmLibrary } from "@/components/files/firm-library";
import { hasAnyPermission, Permission } from "@/lib/rbac/permissions";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function FilesPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // The sidebar hides this from a non-member; enforcing it HERE is what stops
  // the URL being typed in directly.
  const allowed = canViewPage(ctx.permissions, "/files");

  return (
    <PageShell
      title="Files"
      description="What the practice keeps, alongside the files on jobs you can see"
      maxWidth="7xl"
    >
      {allowed ? (
        <FirmLibrary
          orgId={ctx.orgId}
          canUpload={hasAnyPermission(ctx.permissions, Permission.ORG_UPDATE)}
        />
      ) : (
        <NoPageAccess what="files" />
      )}
    </PageShell>
  );
}
