import { prisma } from "@/lib/db/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import { assertPermission, assertProjectRead, loadAuthContext, type ToolContext } from "./_ctx";
import { narrowBoards } from "@/lib/rbac/board-access";

/**
 * Board executor — read-only listing of a project's boards. Org+project scoped.
 * Mirrors `api/v1/orgs/[orgId]/projects/[projectId]/boards` (GET).
 */

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

const listSchema = z.object({ projectId: z.string().uuid() });

export async function listBoards(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.BOARD_READ);
  if (denied) return denied;

  const parsed = listSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId } = parsed.data;

  const outOfScope = await assertProjectRead(ctx, projectId, "BOARD_READ");
  if (outOfScope) return outOfScope;

  const boards = await prisma.board.findMany({
    where: { orgId: ctx.orgId, projectId },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      projectId: true,
      type: true,
      sortOrder: true,
      name: true,
      createdAt: true,
      // Selected for the gate below, then dropped from the reply: which team
      // owns a board is not something the assistant needs to say out loud.
      teamId: true,
    },
  });

  // The TEAM axis, which `assertProjectRead` does not cover — it answers only
  // "may they open this project". Without this the assistant listed boards the
  // sidebar hides: the same second-surface gap as 2.265.3, one axis further in.
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Not a member of this organization" };
  const visible = await narrowBoards(auth, projectId, boards);

  return {
    count: visible.length,
    boards: visible.map(({ teamId: _teamId, ...rest }) => rest),
  };
}
