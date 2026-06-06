import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectWizard } from "./project-wizard";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default function NewProjectPage({ params }: PageParams) {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <NewProjectContent params={params} />
    </Suspense>
  );
}

async function NewProjectContent({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  return (
    <PageShell title="New project" maxWidth="5xl">
      <ProjectWizard orgId={ctx.orgId} orgSlug={orgSlug} />
    </PageShell>
  );
}
