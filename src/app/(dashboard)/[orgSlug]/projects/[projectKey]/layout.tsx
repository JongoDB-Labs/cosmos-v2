import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Settings } from "lucide-react";
import { ProjectBoardTabs } from "./board-tabs";

type LayoutParams = {
  params: Promise<{ orgSlug: string; projectKey: string }>;
  children: React.ReactNode;
};

export default async function ProjectLayout({
  params,
  children,
}: LayoutParams) {
  const { orgSlug, projectKey } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: projectKey, mode: "insensitive" },
      archived: false,
    },
    include: {
      boards: {
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true, type: true },
      },
      projectTemplate: {
        select: { defaultConfig: true },
      },
    },
  });

  if (!project) notFound();

  return (
    <div className="flex flex-col h-full">
      {/* Project header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
            {project.key}
          </span>
          <h1 className="text-lg font-semibold">{project.name}</h1>
        </div>
        <Link
          href={`/${orgSlug}/projects/${projectKey}/settings`}
          aria-label="Project settings"
          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
        >
          <Settings className="h-4 w-4" />
        </Link>
      </div>

      {/* Board tabs */}
      <ProjectBoardTabs
        orgSlug={orgSlug}
        projectKey={projectKey}
        boards={project.boards}
        enabledFeatures={project.enabledFeatures}
        templateDefaultConfig={
          project.projectTemplate?.defaultConfig as Record<string, unknown> | null | undefined
        }
      />

      {/* Board content */}
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
