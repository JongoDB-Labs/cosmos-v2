import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canReadProject } from "@/lib/rbac/project-access";
import { redirect, notFound } from "next/navigation";
import { canSeeProjectMoney } from "@/lib/rbac/money-fields";
import { ClinBurnTracker } from "@/components/pm-dashboard/clin-burn-tracker";
import { ClinEvmPanel } from "@/components/pm-dashboard/clin-evm-panel";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function ClinsPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: { orgId: ctx.orgId, key: { equals: projectKey, mode: "insensitive" }, archived: false },
    select: { id: true },
  });
  if (!project || !(await canReadProject(ctx, project.id))) notFound();

  // The CLIN list is program information; its money is finance data
  // (src/lib/rbac/money-fields.ts). The API leaves the figures out either way;
  // this tells the screens to say "Restricted" instead of drawing blanks.
  const moneyVisible = await canSeeProjectMoney(ctx, project.id);

  return (
    <>
      {moneyVisible && <ClinEvmPanel orgId={ctx.orgId} projectId={project.id} />}
      <ClinBurnTracker orgId={ctx.orgId} projectId={project.id} moneyVisible={moneyVisible} />
    </>
  );
}
