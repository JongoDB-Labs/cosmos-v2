import { prisma } from "@/lib/db/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import { assertPermission, assertProjectRead, loadAuthContext, type ToolContext } from "./_ctx";
import { documentVisibilityWhere } from "@/lib/files/access";

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

  const outOfScope = await assertProjectRead(ctx, projectId, "PROJECT_READ");
  if (outOfScope) return outOfScope;
  // assertProjectRead has already refused a context without one; this is the
  // same caller, needed here for the per-file rule.
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };

  const documents = await prisma.document.findMany({
    // The per-FILE rule, as the HTTP list applies it: a restricted file is
    // hidden from the rest of its own project, and its title is often the
    // thing being kept back.
    where: { orgId: ctx.orgId, projectId, ...documentVisibilityWhere(auth, new Set([projectId])) },
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
