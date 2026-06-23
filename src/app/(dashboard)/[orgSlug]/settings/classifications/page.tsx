import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { ClassificationManager } from "@/components/security/classification-manager";
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

export default async function ClassificationsPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  if (!canViewSettings(ctx, "/settings/classifications")) {
    return (
      <PageShell
        title="Classifications"
        description="Data classification labels"
      >
        <NoAccess what="classifications" />
      </PageShell>
    );
  }

  // Prefetch the classifications list with the same org-scoped key the
  // client uses (see useOrgQueryKey("classifications")).
  const qc = makeServerQueryClient();
  await qc.prefetchQuery({
    queryKey: ["org", orgSlug, "classifications"],
    queryFn: () =>
      prisma.dataClassification.findMany({
        where: { orgId: ctx.orgId },
        orderBy: { createdAt: "desc" },
      }),
  });

  return (
    <PageShell
      title="Classifications"
      description="Data classification labels"
    >
      <HydrationBoundary state={dehydrate(qc)}>
        <ClassificationManager orgId={ctx.orgId} />
      </HydrationBoundary>
    </PageShell>
  );
}
