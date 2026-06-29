import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { PmDashboardNav } from "./pm-nav";

type LayoutParams = {
  params: Promise<{ orgSlug: string; projectKey: string }>;
  children: React.ReactNode;
};

// Wraps the PM Dashboard overview + every register sub-page with a shared
// sub-nav, so the registers live under the dashboard instead of crowding the
// project board-tab strip.
export default async function PmDashboardLayout({ params, children }: LayoutParams) {
  const { orgSlug, projectKey } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: projectKey, mode: "insensitive" },
      archived: false,
    },
    select: { enabledFeatures: true },
  });
  if (!project) notFound();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PmDashboardNav
        orgSlug={orgSlug}
        projectKey={projectKey}
        enabledFeatures={project.enabledFeatures}
      />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{children}</div>
    </div>
  );
}
