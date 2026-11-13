import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { NoPageAccess } from "@/components/ui/no-page-access";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { TemplateEditor } from "./template-editor";

type PageParams = {
  params: Promise<{ orgSlug: string; templateId: string }>;
};

export default function TemplateEditorPage({ params }: PageParams) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TemplateEditorContent params={params} />
    </Suspense>
  );
}

async function TemplateEditorContent({ params }: PageParams) {
  const { orgSlug, templateId } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // The same check as the templates list this editor is opened from. Without it
  // the page loaded and sent a template's configuration to anyone signed in to
  // the org, including a guest.
  if (!canViewSettings(ctx, "/settings/templates")) return <NoPageAccess what="templates" />;

  const template = await prisma.projectTemplate.findUnique({
    where: { id: templateId },
    include: {
      boardTemplates: {
        orderBy: { sortOrder: "asc" },
      },
      workItemTypes: {
        orderBy: { sortOrder: "asc" },
      },
    },
  });

  if (!template) notFound();

  // Only show if built-in or owned by this org
  if (!template.isBuiltIn && template.orgId !== ctx.orgId) notFound();

  // Narrow to the client-facing shape (and stringify the Date).
  const serializable = {
    id: template.id,
    orgId: template.orgId,
    slug: template.slug,
    name: template.name,
    sector: template.sector,
    description: template.description,
    isBuiltIn: template.isBuiltIn,
    defaultConfig: template.defaultConfig as Record<string, unknown>,
    createdAt: template.createdAt.toISOString(),
    boardTemplates: template.boardTemplates.map((b) => ({
      id: b.id,
      name: b.name,
      boardType: b.boardType,
      category: b.category,
      sortOrder: b.sortOrder,
      description: b.description,
      methodology: b.methodology,
    })),
    workItemTypes: template.workItemTypes.map((w) => ({
      id: w.id,
      key: w.key,
      name: w.name,
      pluralName: w.pluralName,
      icon: w.icon,
      color: w.color,
      sortOrder: w.sortOrder,
      defaultParentTypeKey: w.defaultParentTypeKey,
    })),
  };

  return (
    <TemplateEditor
      template={serializable}
      orgId={ctx.orgId}
      orgSlug={orgSlug}
    />
  );
}
