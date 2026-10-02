import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { isProjectVisible } from "@/lib/rbac/project-access";
import { canAdministerProject } from "@/lib/rbac/require-project-manage";

/**
 * Who may see and who may change a stored file.
 *
 * One module rather than the same three clauses copied into each route, because
 * there are now several doors onto a document — the org library, a project's
 * list, an item's attachments, the raw download — and a policy that is spelled
 * out separately in each is a policy that will disagree with itself. It also
 * means per-user and per-team visibility, when it lands, is a change HERE and
 * not an audit of every route.
 */

/** Everything the policy needs, and nothing else, so callers select narrowly. */
export interface DocumentForPolicy {
  id: string;
  orgId: string;
  projectId: string | null;
  uploadedById: string;
}

/**
 * The document, if this actor may see it at all; otherwise null.
 *
 * Null covers three different situations deliberately — no such document, a
 * document in another org, and a document on a project this actor cannot see —
 * because distinguishing them tells an outsider whether an id exists. Callers
 * answer 404 for all three.
 */
export async function readableDocument(
  orgId: string,
  docId: string,
  ctx: AuthContext,
): Promise<DocumentForPolicy | null> {
  const doc = await prisma.document.findFirst({
    where: { id: docId, orgId },
    select: { id: true, orgId: true, projectId: true, uploadedById: true },
  });
  if (!doc) return null;

  // An org-wide document belongs to nobody in particular, so any org reader may
  // see it. The route has already required ORG_READ to get this far.
  if (doc.projectId === null) return doc;

  // A project document is exactly as visible as its project — the same rule the
  // library list applies in its query, so a file cannot be fetched by id after
  // being filtered out of the list.
  return (await isProjectVisible(ctx, doc.projectId)) ? doc : null;
}

/**
 * May this actor rename it, detach it, or delete it?
 *
 * The uploader always may. That is the point of recording who uploaded a file:
 * somebody who put a file somewhere by mistake should not have to find a project
 * manager to take it back out, and they are the one person who certainly has the
 * right to withdraw their own contribution.
 *
 * Otherwise it falls to the right that governs where the file lives — the project
 * for a project file, the org for one filed against no project.
 */
export async function canManageDocument(
  doc: DocumentForPolicy,
  ctx: AuthContext,
): Promise<boolean> {
  if (doc.uploadedById === ctx.userId) return true;
  if (doc.projectId === null) return hasPermission(ctx.permissions, Permission.ORG_UPDATE);
  return canAdministerProject(ctx, doc.projectId);
}

/**
 * `canManage` for a whole page of documents, in one pass.
 *
 * The per-row policy consults the project, so mapping it naively over a list is
 * N+1 against the database. Here each DISTINCT project is asked about once and
 * the answer reused, which is what makes it safe to tell the client which rows
 * to offer a rename or a delete on — without that the list would have to hide
 * the controls from project managers, or show them to everybody and let the
 * route 403.
 */
export async function withManageFlags<T extends { projectId: string | null; uploadedById: string }>(
  docs: readonly T[],
  ctx: AuthContext,
): Promise<Array<T & { canManage: boolean }>> {
  const projectIds = [...new Set(docs.map((d) => d.projectId).filter((p): p is string => !!p))];
  const manageable = new Set<string>();
  await Promise.all(
    projectIds.map(async (id) => {
      if (await canAdministerProject(ctx, id)) manageable.add(id);
    }),
  );
  const orgWide = hasPermission(ctx.permissions, Permission.ORG_UPDATE);
  return docs.map((d) => ({
    ...d,
    canManage:
      d.uploadedById === ctx.userId ||
      (d.projectId === null ? orgWide : manageable.has(d.projectId)),
  }));
}
