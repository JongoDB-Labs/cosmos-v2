import { prisma } from "@/lib/db/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import { assertPermission, type ToolContext } from "./_ctx";

/**
 * Document executor — read-only listing of a project's ingested documents.
 * Org+project scoped. Mirrors `api/v1/orgs/[orgId]/projects/[projectId]/documents`
 * (GET). No dedicated DOC permission bit exists, so this uses PROJECT_READ
 * (the same gate the HTTP GET route enforces).
 */

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

const listSchema = z.object({
  projectId: z.string().uuid(),
  limit: z.number().int().positive().optional(),
});

export async function listDocuments(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_READ);
  if (denied) return denied;

  const parsed = listSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, limit } = parsed.data;

  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId: ctx.orgId },
    select: { id: true },
  });
  if (!project) return { error: "Project not found" };

  const documents = await prisma.document.findMany({
    where: { orgId: ctx.orgId, projectId },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit ?? 50, 100),
    select: {
      id: true, projectId: true, uploadedById: true, contentType: true, format: true,
      status: true, size: true, pageCount: true, classificationLevel: true,
      title: true, createdAt: true, updatedAt: true,
    },
  });
  return { count: documents.length, documents };
}
