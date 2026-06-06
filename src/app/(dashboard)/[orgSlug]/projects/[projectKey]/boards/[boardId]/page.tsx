import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { BoardRenderer } from "./board-renderer";

type PageParams = {
  params: Promise<{
    orgSlug: string;
    projectKey: string;
    boardId: string;
  }>;
};

export default async function BoardPage({ params }: PageParams) {
  const { orgSlug, projectKey, boardId } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: projectKey, mode: "insensitive" },
      archived: false,
    },
    select: { id: true, key: true },
  });

  if (!project) notFound();

  const board = await prisma.board.findFirst({
    where: { id: boardId, projectId: project.id },
    select: { id: true, type: true },
  });

  if (!board) notFound();

  return (
    <BoardRenderer
      orgId={ctx.orgId}
      projectId={project.id}
      projectKey={project.key}
      boardId={board.id}
      boardType={board.type}
    />
  );
}
