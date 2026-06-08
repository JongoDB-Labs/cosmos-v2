import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { WorkItemImportWizard } from "@/components/import/work-item-import-wizard";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function ProjectImportPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: projectKey, mode: "insensitive" },
    },
    select: {
      id: true,
      boards: {
        orderBy: { sortOrder: "asc" },
        select: {
          columns: {
            orderBy: { sortOrder: "asc" },
            select: { key: true, name: true },
          },
        },
      },
    },
  });
  if (!project) notFound();

  // Distinct board columns across the project (status → columnKey targets).
  const seen = new Set<string>();
  const columns: { key: string; name: string }[] = [];
  for (const b of project.boards) {
    for (const c of b.columns) {
      if (!seen.has(c.key)) {
        seen.add(c.key);
        columns.push({ key: c.key, name: c.name });
      }
    }
  }

  // Work-item types available to this org (its own + built-ins).
  const typeRows = await prisma.workItemType.findMany({
    where: { OR: [{ orgId: ctx.orgId }, { orgId: null, isBuiltIn: true }] },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, key: true },
  });
  const types = typeRows.map((t) => ({ id: t.id, name: t.name }));

  // Members (assigneeId references the user id).
  const memberRows = await prisma.orgMember.findMany({
    where: { orgId: ctx.orgId },
    select: { user: { select: { id: true, displayName: true, email: true } } },
  });
  const members = memberRows
    .filter((m) => m.user)
    .map((m) => ({ id: m.user.id, name: m.user.displayName, email: m.user.email }));

  const defaultType =
    typeRows.find((t) => /task/i.test(t.key) || /task/i.test(t.name)) ?? typeRows[0];

  if (!defaultType) {
    // No work-item types at all — can't import without a target type.
    return (
      <PageShell title="Import work items" description={`Project ${projectKey}`}>
        <p className="text-sm text-[var(--text-muted)]">
          This workspace has no work-item types configured, so there&apos;s
          nothing to import into yet.
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Import work items"
      description={`Bring issues into ${projectKey} from a Jira / CSV / Excel export`}
      maxWidth="5xl"
    >
      <WorkItemImportWizard
        orgId={ctx.orgId}
        projectId={project.id}
        orgSlug={orgSlug}
        projectKey={projectKey}
        columns={columns}
        types={types}
        members={members}
        defaults={{
          columnKey: columns[0]?.key ?? "todo",
          workItemTypeId: defaultType.id,
        }}
      />
    </PageShell>
  );
}
