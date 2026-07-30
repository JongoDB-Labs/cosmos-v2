import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { ProjectSettingsClient } from "./project-settings-client";
import { MentionedIn } from "@/components/mentions/mentioned-in";

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
      krLinkTypeId: true,
      objectiveLinkTypeId: true,
      settings: true,
      // For the "Default boards" section. Ordered as the board strip orders
      // them so the settings list matches what people actually see.
      boards: {
        select: { id: true, name: true, type: true },
        orderBy: { sortOrder: "asc" },
      },
      teamScopedAccess: true,
    },
  });

  if (!project) notFound();

  const disabledBoardTypes =
    ((project.settings as { disabledBoardTypes?: string[] } | null)?.disabledBoardTypes) ?? [];
  // The PROJECT-WIDE baseline of boards hidden from the strip. layout.tsx has
  // always read this (`tp.hiddenBoardIds ?? projectSettings.hiddenBoardIds`)
  // but nothing ever wrote it — the mechanism existed with no way to set it.
  const hiddenBoardIds =
    ((project.settings as { hiddenBoardIds?: string[] } | null)?.hiddenBoardIds) ?? [];

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
        disabledBoardTypes={disabledBoardTypes}
        krLinkTypeId={project.krLinkTypeId}
        objectiveLinkTypeId={project.objectiveLinkTypeId}
        boards={project.boards}
        hiddenBoardIds={hiddenBoardIds}
        teamScopedAccess={project.teamScopedAccess}
      />
      <MentionedIn
        orgId={ctx.orgId}
        type="project"
        id={project.id}
        className="mt-8 border-t pt-6"
      />
    </div>
  );
}
