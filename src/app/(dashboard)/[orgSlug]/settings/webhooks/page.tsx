import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { WebhooksManager } from "@/components/settings/webhooks-manager";
import { PageShell } from "@/components/ui/page-shell";
import {
  makeServerQueryClient,
  dehydrate,
  HydrationBoundary,
} from "@/lib/query/server";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { NoAccess } from "@/components/settings/no-access";
import { listWebhooks } from "@/lib/webhooks/access.server";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function WebhooksPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  if (!canViewSettings(ctx, "/settings/webhooks")) {
    return (
      <PageShell title="Webhooks" description="Outbound event subscriptions">
        <NoAccess what="webhooks" />
      </PageShell>
    );
  }

  // Prefetch the webhooks list with the same org-scoped key the client uses
  // (see useOrgQueryKey("webhooks", "list") in WebhooksManager).
  const qc = makeServerQueryClient();
  await qc.prefetchQuery({
    queryKey: ["org", orgSlug, "webhooks", "list"],
    // The GET route's own list: no sealed `secret` in the hydrated cache that
    // ships to the browser, and each webhook's paused reason.
    queryFn: () => listWebhooks(ctx.orgId),
  });

  return (
    <PageShell title="Webhooks" description="Outbound event subscriptions">
      <HydrationBoundary state={dehydrate(qc)}>
        <WebhooksManager orgId={ctx.orgId} />
      </HydrationBoundary>
    </PageShell>
  );
}
