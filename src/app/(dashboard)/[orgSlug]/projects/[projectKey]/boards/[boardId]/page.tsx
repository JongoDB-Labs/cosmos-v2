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

  // The [boardId] segment is the human-readable slug for new boards, but old
  // links (and boards created before slugs existed) use the UUID — resolve either.
  // Only match by id when the segment actually looks like a UUID, so a slug never
  // hits the uuid column type.
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const board = await prisma.board.findFirst({
    where: {
      projectId: project.id,
      OR: [{ slug: boardId }, ...(UUID_RE.test(boardId) ? [{ id: boardId }] : [])],
    },
    select: { id: true, slug: true, type: true, name: true, config: true },
  });

  if (!board) notFound();

  // Canonicalize to the readable slug URL when reached via UUID (or a stale slug).
  if (board.slug && boardId !== board.slug) {
    redirect(`/${orgSlug}/projects/${projectKey}/boards/${board.slug}`);
  }

  // A board's view variant lives in its config (e.g. a TIMELINE board rendered as
  // the static "release-timeline" snapshot vs the interactive Gantt default).
  // Templates seed config.mode explicitly. For TIMELINE boards created BEFORE the
  // Gantt/Release-Timeline split (no config.mode), fall back to a name signal so a
  // board literally called "Release Timeline" opens as the static snapshot without
  // a data backfill; explicit config.mode always wins.
  const cfg = (board.config ?? {}) as { mode?: string };
  const viewMode =
    cfg.mode ??
    (board.type === "TIMELINE" && /release\s*timeline/i.test(board.name)
      ? "release-timeline"
      : null);

  return (
    <BoardRenderer
      orgId={ctx.orgId}
      projectId={project.id}
      projectKey={project.key}
      boardId={board.id}
      boardType={board.type}
      viewMode={viewMode}
    />
  );
}
