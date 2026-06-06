import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { TemplateGallery } from "./template-gallery";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default function TemplatesSettingsPage({ params }: PageParams) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TemplatesContent params={params} />
    </Suspense>
  );
}

async function TemplatesContent({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell
      title="Templates"
      description="Browse built-in project templates or manage your org's custom templates"
    >
      <TemplateGallery orgId={ctx.orgId} orgSlug={orgSlug} />
    </PageShell>
  );
}
