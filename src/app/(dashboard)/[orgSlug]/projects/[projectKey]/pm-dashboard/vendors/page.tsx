import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canReadProject } from "@/lib/rbac/project-access";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
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
  if (!project || !(await canReadProject(ctx, project.id))) notFound();

  // The partner picker is the partners list, which needs CRM_READ; without it
  // the page names none.
  const partners = !hasPermission(ctx.permissions, Permission.CRM_READ) ? [] : await prisma.partner.findMany({
    where: { orgId: ctx.orgId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return (
    <VendorTracker orgId={ctx.orgId} projectId={project.id} partners={partners} />
  );
}
