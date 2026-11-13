import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canReadProject } from "@/lib/rbac/project-access";
import { redirect, notFound } from "next/navigation";
import { isBoardVisible } from "@/lib/rbac/board-access";
import { canEditSharedLayout } from "@/lib/rbac/board-ownership";
import { rendersSavedWidgets } from "@/lib/boards/board-types";
import { readBuilderWidgets } from "@/lib/boards/widget-data";
import { BoardBuilder } from "@/components/boards/builder/board-builder";
import type { Board } from "@/types/models";

type PageParams = {
  params: Promise<{
    orgSlug: string;
    projectKey: string;
    boardId: string;
  }>;
  searchParams: Promise<{ view?: string | string[] }>;
};

export default async function BuilderPage({ params, searchParams }: PageParams) {
  const { orgSlug, projectKey, boardId } = await params;
  const { view } = await searchParams;

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

  if (!project || !(await canReadProject(ctx, project.id))) notFound();

  // Resolve slug OR uuid, exactly as the board page beside it does.
  //
  // This matched `id` alone, while the board page resolves either and then
  // canonically REDIRECTS uuid→slug — so the URL any user actually holds is
  // `/boards/<slug>`, and `<that>/builder` 404'd. The one form that worked was
  // a uuid nobody sees. Only match the id column when the segment looks like a
  // uuid, so a slug never hits a uuid column type.
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const board = await prisma.board.findFirst({
    where: {
      projectId: project.id,
      OR: [{ slug: boardId }, ...(UUID_RE.test(boardId) ? [{ id: boardId }] : [])],
    },
    select: {
      id: true,
      name: true,
      type: true,
      config: true,
      teamId: true,
      ownerId: true,
    },
  });

  if (!board) notFound();

  // Team axis — the builder is a second URL onto the same board, and editing its
  // structure is strictly more than reading it. `notFound()` rather than a
  // refusal, so it cannot be used to confirm the board exists.
  if (!(await isBoardVisible(ctx, project.id, board))) notFound();

  // Which layout this page edits. The SHARED one only for someone the board PUT
  // route would let change it (a manager, or the board's creator); everyone
  // else who can see the board gets their OWN arrangement of it, saved to
  // `…/my-layout`, which changes nothing for anyone else. `?view=mine` lets an
  // editor choose their own arrangement too.
  const canEditShared = await canEditSharedLayout(ctx, project.id, board);
  const personal = view === "mine" || !canEditShared;
  // A personal layout is a layout of WIDGETS; a board that draws none has
  // nothing for one to arrange.
  if (personal && !rendersSavedWidgets(board.type)) notFound();
  const mine = personal
    ? await prisma.personalBoardLayout.findUnique({
        where: { boardId_userId: { boardId: board.id, userId: ctx.userId } },
        select: { widgets: true },
      })
    : null;

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
      // Keyed by mode: switching between the shared and the personal layout is
      // the same route with a different query, which would otherwise keep the
      // builder mounted with the other layout still loaded.
      key={personal ? "personal" : "shared"}
      orgId={ctx.orgId}
      projectId={project.id}
      boardId={board.id}
      initialBoard={serializedBoard}
      sector={sector}
      mode={personal ? "personal" : "shared"}
      canEditShared={canEditShared}
      personalWidgets={
        mine ? readBuilderWidgets({ widgets: mine.widgets }) : null
      }
      boardHref={`/${orgSlug}/projects/${project.key}/boards/${boardId}`}
    />
  );
}
