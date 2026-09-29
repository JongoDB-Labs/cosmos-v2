import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { canViewPage } from "@/lib/nav/page-access";
import { NoPageAccess } from "@/components/ui/no-page-access";
import { PageShell } from "@/components/ui/page-shell";
import { InboxWorkspace } from "@/components/notifications/inbox-workspace";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function InboxPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // The sidebar hides this from anyone without the permission; enforcing it
  // HERE is what stops the URL being typed in directly.
  const allowed = canViewPage(ctx.permissions, "/inbox");

  return (
    <PageShell
      tourAnchor="inbox"
      title="Inbox"
      description="Everything waiting on you, grouped by what kind of thing it is"
      maxWidth="5xl"
    >
      {allowed ? (
        <InboxWorkspace orgId={ctx.orgId} />
      ) : (
        <NoPageAccess what="your inbox" />
      )}
    </PageShell>
  );
}
