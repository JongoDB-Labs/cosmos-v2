import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { WebhooksManager } from "@/components/settings/webhooks-manager";
import { PageShell } from "@/components/ui/page-shell";
import {
  makeServerQueryClient,
  dehydrate,
  HydrationBoundary,
} from "@/lib/query/server";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function WebhooksPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // Prefetch the webhooks list with the same org-scoped key the client uses
  // (see useOrgQueryKey("webhooks", "list") in WebhooksManager).
  const qc = makeServerQueryClient();
  await qc.prefetchQuery({
    queryKey: ["org", orgSlug, "webhooks", "list"],
    // Match the GET route's projection — keep the sealed `secret` out of the
    // hydrated cache that ships to the browser.
    queryFn: () =>
      prisma.webhook.findMany({
        where: { orgId: ctx.orgId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          orgId: true,
          url: true,
          events: true,
          active: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  });

  return (
    <PageShell title="Webhooks" description="Outbound event subscriptions">
      <HydrationBoundary state={dehydrate(qc)}>
        <WebhooksManager orgId={ctx.orgId} />
      </HydrationBoundary>
    </PageShell>
  );
}
