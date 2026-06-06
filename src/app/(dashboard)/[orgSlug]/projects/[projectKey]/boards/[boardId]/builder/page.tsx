import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { BoardBuilder } from "@/components/boards/builder/board-builder";
import type { Board } from "@/types/models";

type PageParams = {
  params: Promise<{
    orgSlug: string;
    projectKey: string;
    boardId: string;
  }>;
};

export default async function BuilderPage({ params }: PageParams) {
  const { orgSlug, projectKey, boardId } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: projectKey, mode: "insensitive" },
      archived: false,
    },
    select: { id: true, key: true, projectTemplateId: true },
  });

  if (!project) notFound();

  const board = await prisma.board.findFirst({
    where: { id: boardId, projectId: project.id },
    select: { id: true, name: true, type: true, config: true },
  });

  if (!board) notFound();

  let sector: string | undefined;
  if (project.projectTemplateId) {
    const tpl = await prisma.projectTemplate.findUnique({
      where: { id: project.projectTemplateId },
      select: { sector: true },
    });
    if (tpl?.sector) sector = tpl.sector;
  }

  const serializedBoard: Board = {
    id: board.id,
    orgId: ctx.orgId,
    projectId: project.id,
    name: board.name,
    type: board.type as Board["type"],
    config: (board.config as Record<string, unknown>) ?? {},
    sortOrder: 0,
    createdAt: "",
  };

  return (
    <BoardBuilder
      orgId={ctx.orgId}
      projectId={project.id}
      boardId={board.id}
      initialBoard={serializedBoard}
      sector={sector}
    />
  );
}
