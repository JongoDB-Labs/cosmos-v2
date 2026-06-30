import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { ImportWizard } from "@/components/import/import-wizard";

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

  // Default work-item type for the Work Items flow (falls back to the first
  // available; "" when the workspace has none — only the Work Items card needs
  // it, the generic entity flows don't).
  const defaultType =
    typeRows.find((t) => /task/i.test(t.key) || /task/i.test(t.name)) ?? typeRows[0];

  return (
    <PageShell
      title="Import"
      description={`Bring records into ${projectKey} from a CSV / Excel export`}
      maxWidth="5xl"
    >
      <ImportWizard
        orgId={ctx.orgId}
        projectId={project.id}
        orgSlug={orgSlug}
        projectKey={projectKey}
        columns={columns}
        types={types}
        members={members}
        defaults={{
          columnKey: columns[0]?.key ?? "todo",
          workItemTypeId: defaultType?.id ?? "",
        }}
      />
    </PageShell>
  );
}
