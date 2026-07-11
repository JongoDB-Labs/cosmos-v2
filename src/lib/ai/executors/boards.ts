import { prisma } from "@/lib/db/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import { assertPermission, type ToolContext } from "./_ctx";

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

  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId: ctx.orgId },
    select: { id: true },
  });
  if (!project) return { error: "Project not found" };

  const boards = await prisma.board.findMany({
    where: { orgId: ctx.orgId, projectId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, projectId: true, type: true, sortOrder: true, name: true, createdAt: true },
  });
  return { count: boards.length, boards };
}
