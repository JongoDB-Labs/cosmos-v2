import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { ProjectSettingsClient } from "./project-settings-client";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function ProjectSettingsPage({ params }: PageParams) {
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
      name: true,
      key: true,
      description: true,
      enabledFeatures: true,
    },
  });

  if (!project) notFound();

  // No PageShell here: the project layout already renders the project name as
  // the page's single <h1>; this section uses an <h2> so we don't stack two H1s.
  return (
    <div className="mx-auto max-w-5xl p-8">
      <h2 className="mb-8 text-2xl font-semibold tracking-tight">
        Project Settings
      </h2>
      <ProjectSettingsClient
        orgId={ctx.orgId}
        orgSlug={orgSlug}
        projectId={project.id}
        projectName={project.name}
        projectKey={project.key}
        projectDescription={project.description ?? ""}
        enabledFeatures={project.enabledFeatures}
      />
    </div>
  );
}
