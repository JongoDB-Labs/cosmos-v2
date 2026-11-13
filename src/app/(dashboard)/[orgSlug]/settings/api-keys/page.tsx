import { getAuthContext, getCurrentUser } from "@/lib/auth/session";
import { redirect } from "next/navigation";
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
import { managesAllApiKeys, scopeVerdicts } from "@/lib/auth/api-key-policy";
import { listApiKeysFor, mintStanding } from "@/lib/auth/api-key-manage.server";

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
        tourAnchor="api-keys"
        title="API keys"
        description="Bearer tokens for the Cosmos API"
      >
        <NoAccess what="API keys" />
      </PageShell>
    );
  }

  // Decided here with the same rules the API applies, so the page never
  // offers what the server would refuse. Seeing every key is a session's
  // (ctx.permissions); what a new key may be is judged as the verifier will
  // judge it (mintStanding: permissions as a key sees them, the org's switch
  // and its single sign-on).
  const managesAll = managesAllApiKeys(ctx.permissions);
  const session = await getCurrentUser();
  const mint = await mintStanding(ctx, session?.idpConnId ?? null);

  // Prefetch the key list with the same org-scoped key the client uses
  // (see useOrgQueryKey("api-keys") in ApiKeysManager), through the same
  // function the GET route answers with, so `keyHash` never reaches the browser.
  const qc = makeServerQueryClient();
  await qc.prefetchQuery({
    queryKey: ["org", orgSlug, "api-keys"],
    queryFn: () => listApiKeysFor(ctx, managesAll),
  });

  return (
    <PageShell
      title="API keys"
      description="Bearer tokens for the Cosmos API"
    >
      <HydrationBoundary state={dehydrate(qc)}>
        <ApiKeysManager
          orgId={ctx.orgId}
          currentUserId={ctx.userId}
          managesAll={managesAll}
          mintsWithoutLimit={mint.managesAll}
          createRefusal={mint.refusal}
          memberKeysOff={!mint.policy.memberApiKeysEnabled}
          scopes={scopeVerdicts(mint.permissions)}
        />
      </HydrationBoundary>
      <ApiReference orgId={ctx.orgId} />
    </PageShell>
  );
}
