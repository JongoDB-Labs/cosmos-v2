import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { ApiKeysManager } from "@/components/settings/api-keys-manager";
import { ApiReference } from "@/components/settings/api-reference";
import { PageShell } from "@/components/ui/page-shell";
import {
  makeServerQueryClient,
  dehydrate,
  HydrationBoundary,
} from "@/lib/query/server";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { NoAccess } from "@/components/settings/no-access";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function ApiKeysPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  if (!canViewSettings(ctx, "/settings/api-keys")) {
    return (
      <PageShell
        title="API keys"
        description="Bearer tokens for the Cosmos API"
      >
        <NoAccess what="API keys" />
      </PageShell>
    );
  }

  // Prefetch the key list with the same org-scoped key the client uses
  // (see useOrgQueryKey("api-keys") in ApiKeysManager). Match the GET route's
  // projection — `keyHash` is never selected so it can't reach the browser.
  const qc = makeServerQueryClient();
  await qc.prefetchQuery({
    queryKey: ["org", orgSlug, "api-keys"],
    queryFn: () =>
      prisma.apiKey.findMany({
        where: { orgId: ctx.orgId },
        select: {
          id: true,
          name: true,
          prefix: true,
          scopes: true,
          expiresAt: true,
          lastUsed: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
  });

  return (
    <PageShell
      title="API keys"
      description="Bearer tokens for the Cosmos API"
    >
      <HydrationBoundary state={dehydrate(qc)}>
        <ApiKeysManager orgId={ctx.orgId} />
      </HydrationBoundary>
      <ApiReference orgId={ctx.orgId} />
    </PageShell>
  );
}
