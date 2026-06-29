import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { VendorTracker } from "@/components/pm-dashboard/vendor-tracker";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function VendorsPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: { orgId: ctx.orgId, key: { equals: projectKey, mode: "insensitive" }, archived: false },
    select: { id: true },
  });
  if (!project) notFound();

  const partners = await prisma.partner.findMany({
    where: { orgId: ctx.orgId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return (
    <VendorTracker orgId={ctx.orgId} projectId={project.id} partners={partners} />
  );
}
