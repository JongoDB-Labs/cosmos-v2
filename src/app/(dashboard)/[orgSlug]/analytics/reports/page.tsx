import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { ReportsManager } from "@/components/analytics/reports-manager";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import {
  makeServerQueryClient,
  dehydrate,
  HydrationBoundary,
} from "@/lib/query/server";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default function ReportsPage({ params }: PageParams) {
  return (
    <Suspense fallback={<ReportsPageSkeleton />}>
      <ReportsPageContent params={params} />
    </Suspense>
  );
}

async function ReportsPageContent({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const qc = makeServerQueryClient();
  await qc.prefetchQuery({
    queryKey: ["org", orgSlug, "analytics", "reports"],
    queryFn: () =>
      prisma.savedReport.findMany({
        where: { orgId: ctx.orgId },
        orderBy: { createdAt: "desc" },
      }),
  });

  return (
    <PageShell title="Reports" description="Saved analytics reports" maxWidth="7xl">
      <HydrationBoundary state={dehydrate(qc)}>
        <ReportsManager orgId={ctx.orgId} />
      </HydrationBoundary>
    </PageShell>
  );
}

function ReportsPageSkeleton() {
  return (
    <div className="mx-auto max-w-7xl p-8">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-2 h-4 w-56" />
      <div className="mt-6 space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}
