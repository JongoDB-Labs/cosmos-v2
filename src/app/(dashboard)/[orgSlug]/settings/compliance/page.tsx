import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { ComplianceDashboard } from "@/components/compliance/compliance-dashboard";
import { PageShell } from "@/components/ui/page-shell";
import {
  makeServerQueryClient,
  dehydrate,
  HydrationBoundary,
} from "@/lib/query/server";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function CompliancePage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const qc = makeServerQueryClient();
  await qc.prefetchQuery({
    queryKey: ["org", orgSlug, "compliance", "controls"],
    queryFn: () =>
      prisma.complianceControl.findMany({
        where: { orgId: ctx.orgId },
        orderBy: { createdAt: "asc" },
      }),
  });

  return (
    <PageShell
      title="Compliance"
      description="Frameworks, controls, and posture"
    >
      <HydrationBoundary state={dehydrate(qc)}>
        <ComplianceDashboard orgId={ctx.orgId} />
      </HydrationBoundary>
    </PageShell>
  );
}
