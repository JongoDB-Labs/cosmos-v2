import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { ApiKeysManager } from "@/components/settings/api-keys-manager";
import { PageShell } from "@/components/ui/page-shell";
import {
  makeServerQueryClient,
  dehydrate,
  HydrationBoundary,
} from "@/lib/query/server";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function ApiKeysPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  if (!hasPermission(ctx.permissions, Permission.API_KEY_MANAGE)) {
    redirect(`/${orgSlug}/settings`);
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
    </PageShell>
  );
}
