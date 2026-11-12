import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canReadProject } from "@/lib/rbac/project-access";
import { redirect, notFound } from "next/navigation";
import { canSeeProjectMoney } from "@/lib/rbac/money-fields";
import { ChangeTracker } from "@/components/pm-dashboard/change-tracker";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function ChangesPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: { orgId: ctx.orgId, key: { equals: projectKey, mode: "insensitive" }, archived: false },
    select: { id: true },
  });
  if (!project || !(await canReadProject(ctx, project.id))) notFound();

  // Cost impact is finance data (src/lib/rbac/money-fields.ts); the API leaves
  // it out, and this tells the screen to say "Restricted" rather than blank.
  const moneyVisible = await canSeeProjectMoney(ctx, project.id);

  return <ChangeTracker orgId={ctx.orgId} projectId={project.id} moneyVisible={moneyVisible} />;
}
