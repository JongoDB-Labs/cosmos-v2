import { prisma } from "@/lib/db/client";
import { inKeyProjectScope, type AuthContext } from "@/lib/rbac/check";
import type { DocumentVisibility } from "@prisma/client";
import { Permission, hasPermission, type PermissionKey } from "@/lib/rbac/permissions";
import { isOrgAdministrator } from "@/lib/rbac/project-access";
import { canAdministerProject } from "@/lib/rbac/require-project-manage";
import { canReadInProject } from "@/lib/rbac/require-project-read";
import { roleCountsFor } from "@/lib/rbac/key-role";
import { getReadableProjectIds, projectsDenyingAction } from "@/lib/work-items/query/scope";

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

/**
 * What reading a project's file asks of the project: the question the routes
 * under projects/[projectId]/documents put to it. Every other door onto the
 * same file (the org library, its download, search, @-mentions) asks it too, so
 * a rule that closes the project to somebody closes its files on all of them.
 */
export const DOCUMENT_READ: PermissionKey = "PROJECT_READ";

/**
 * Whether this caller's effective permissions include reading files at all.
 *
 * Asked before any of the grants on a restricted file (the uploader, an org
 * administrator, a share), because those are facts about the PERSON and an API
 * key carries its minter's person: the same user id and the same org role, with
 * only its permissions narrowed to its scopes. Without this an administrator's
 * key scoped away from files still opened every restricted file on the role
 * alone. Every role that reaches the file routes holds the bit, so for a person
 * signed in this changes nothing.
 */
function readsFiles(ctx: AuthContext): boolean {
  return hasPermission(ctx.permissions, Permission[DOCUMENT_READ]);
}

/** Everything the policy needs, and nothing else, so callers select narrowly. */
export interface DocumentForPolicy {
  id: string;
  orgId: string;
  projectId: string | null;
  uploadedById: string;
  visibility: DocumentVisibility;
}

/**
 * The document, if this actor may see it at all; otherwise null.
 *
 * Null covers three different situations deliberately — no such document, a
 * document in another org, and a document on a project this actor cannot see —
 * because distinguishing them tells an outsider whether an id exists. Callers
 * answer 404 for all three.
 *
 * The rule, which every door asks:
 * - An INHERIT file is exactly as readable as its project under DOCUMENT_READ:
 *   the bit, any allow/deny rule on that project, and team scoping.
 * - A RESTRICTED file is for its uploader, the people it was shared with and
 *   org administrators, and only once the caller's permissions include reading
 *   files: an API key's scopes bind before its minter's role. That grant opens
 *   it on every door, from outside a team-scoped project too, unless a rule
 *   denies this person the project.
 * - An API key never reaches a file filed outside its projects.
 */
export async function readableDocument(
  orgId: string,
  docId: string,
  ctx: AuthContext,
): Promise<DocumentForPolicy | null> {
  const doc = await prisma.document.findFirst({
    where: { id: docId, orgId },
    select: {
      id: true, orgId: true, projectId: true, uploadedById: true, visibility: true,
    },
  });
  if (!doc) return null;
  // A project-scoped key sees no file filed in another project, not even one its
  // minter uploaded or was shared: the key's ceiling binds before any grant.
  if (doc.projectId && !inKeyProjectScope(ctx, doc.projectId)) return null;

  if (doc.visibility === "RESTRICTED") {
    // The uploader, the people they named, and org administrators. Checked FIRST
    // and without consulting the project, because an explicit grant is the point
    // of sharing: naming somebody outside the project is the "share" half of
    // limit-or-share, and it is recorded with who granted it so the question
    // "why can she see this" has an answer.
    // Stated plainly rather than implied: restricting a file hides it from the
    // rest of the project, not from the people who run the organization. Somebody
    // has to be able to reach a file after its uploader leaves, and the same
    // exemption already exists for team-scoped projects in isProjectVisible.
    if (!readsFiles(ctx)) return null;
    const granted =
      doc.uploadedById === ctx.userId ||
      isOrgAdministrator(ctx.orgRole) ||
      (await prisma.documentShare.findFirst({ where: { documentId: docId, userId: ctx.userId }, select: { id: true } })) !== null;
    if (!granted) return null;
    // The grant does not need the project's team or the role's bit (sharing
    // with somebody outside the project is what it is for), but a rule that
    // denies this person the project still holds, as it does on every door.
    if (doc.projectId && (await projectsDenyingAction(ctx, DOCUMENT_READ, [doc.projectId])).size > 0) return null;
    return doc;
  }

  // An org-wide document belongs to nobody in particular, so any org reader may
  // see it. The route has already required ORG_READ to get this far.
  if (doc.projectId === null) return doc;

  // A project document is exactly as readable as its project, by the question
  // the project's own document routes ask, and the one the list asks in its
  // query: so a file cannot be fetched here after being filtered out there.
  return (await canReadInProject(ctx, doc.projectId, DOCUMENT_READ)) ? doc : null;
}

/**
 * `readableDocument` for a route that names the project in its path.
 *
 * The routes under projects/[projectId]/documents/[docId] gated on the PROJECT
 * alone and then fetched the file by id, so a restricted file was hidden from
 * its project's list and still opened, downloaded, converted and summarised for
 * every reader of that project. Those doors ask this now. A file filed under a
 * different project than the path names is the same miss as one that does not
 * exist.
 */
export async function readableProjectDocument(
  orgId: string,
  projectId: string,
  docId: string,
  ctx: AuthContext,
): Promise<DocumentForPolicy | null> {
  const doc = await readableDocument(orgId, docId, ctx);
  return doc && doc.projectId === projectId ? doc : null;
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
  // Narrower than DocumentForPolicy on purpose: who may CHANGE a file does not
  // depend on how widely it can be READ, and asking for the whole shape would
  // make every caller select a column this function never looks at.
  doc: Pick<DocumentForPolicy, "projectId" | "uploadedById">,
  ctx: AuthContext,
): Promise<boolean> {
  if (doc.uploadedById === ctx.userId) return true;
  // Changing or deleting someone else's file is a delete-grade decision, so an
  // API key does it only when its scopes grant ITEM_DELETE (lib/rbac/key-role.ts);
  // otherwise it manages the files its owner uploaded, and no others.
  if (!roleCountsFor(ctx, Permission.ITEM_DELETE)) return false;
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
  // The same rule as canManageDocument: a key without ITEM_DELETE manages only its owner's uploads.
  if (!roleCountsFor(ctx, Permission.ITEM_DELETE)) {
    return docs.map((d) => ({ ...d, canManage: d.uploadedById === ctx.userId }));
  }
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

/**
 * The same visibility rule as a Prisma `where` fragment, for the LIST queries.
 *
 * It exists because a restricted file has to vanish from the list, not merely 404
 * when fetched by id: a library that shows a filename and then refuses the
 * download has already disclosed the thing worth hiding. Expressed once here so
 * the org list, a project's list and `readableDocument` cannot drift apart —
 * three hand-written copies of this clause is three chances to get it wrong, and
 * the failure is silent in the direction that matters.
 *
 * `visibleProjectIds` is the already-narrowed set for INHERIT files, or null to
 * mean "org-wide files only" (the ?scope=org case). `deniedProjectIds` are the
 * projects a rule denies this caller, which close even a file shared with them
 * (`projectsDenyingAction`). A route under one project has already asked the
 * project, so only the org-wide doors need it: see orgDocumentVisibilityWhere.
 */
export function documentVisibilityWhere(
  ctx: AuthContext,
  visibleProjectIds: ReadonlySet<string> | null,
  deniedProjectIds: ReadonlySet<string> = new Set(),
) {
  const inherit =
    visibleProjectIds === null
      ? { projectId: null }
      : { OR: [{ projectId: null }, { projectId: { in: [...visibleProjectIds] } }] };

  // A project-scoped key sees no restricted file filed in another project, not
  // even one its minter uploaded or was shared: readableDocument applies the
  // key's ceiling before any grant, so the list must too, or it names files the
  // by-id route then refuses. (INHERIT files are already narrowed: the caller's
  // visibleProjectIds carries the key's ceiling.) Absent for a session, so the
  // fragment is unchanged for everybody who is not using a scoped key.
  const keyCeiling = ctx.projectScope
    ? { OR: [{ projectId: null }, { projectId: { in: [...ctx.projectScope] } }] }
    : null;
  // The null arm is spelled out: NOT IN is unknown for a null column, which
  // would drop every org-wide file along with the denied projects' ones.
  const notDenied = deniedProjectIds.size
    ? { OR: [{ projectId: null }, { projectId: { notIn: [...deniedProjectIds] } }] }
    : null;
  // "Org-wide files only" means restricted ones too: a restricted file filed in
  // a project is no more org-wide for being readable.
  const orgOnly = visibleProjectIds === null ? { projectId: null } : null;
  const restrictedBounds = [orgOnly, keyCeiling, notDenied].filter((c) => c !== null);

  // No grant on a restricted file counts without the bit for reading files, as
  // readableDocument decides: a key's scopes bind before its minter's role, its
  // upload or a share with its minter. So such a caller lists INHERIT files only.
  if (!readsFiles(ctx)) return { visibility: "INHERIT" as DocumentVisibility, ...inherit };

  // An administrator sees restricted files too, which is the decision recorded in
  // readableDocument. Their INHERIT clause is unchanged: isProjectVisible already
  // returns true for them, so visibleProjectIds is the full set.
  if (isOrgAdministrator(ctx.orgRole)) {
    return {
      OR: [
        { visibility: "INHERIT" as DocumentVisibility, ...inherit },
        { visibility: "RESTRICTED" as DocumentVisibility, ...(restrictedBounds.length && { AND: restrictedBounds }) },
      ],
    };
  }

  return {
    OR: [
      { visibility: "INHERIT" as DocumentVisibility, ...inherit },
      {
        visibility: "RESTRICTED" as DocumentVisibility,
        ...(restrictedBounds.length && { AND: restrictedBounds }),
        OR: [
          { uploadedById: ctx.userId },
          { shares: { some: { userId: ctx.userId } } },
        ],
      },
    ],
  };
}

/**
 * `documentVisibilityWhere` for a door with no project in its path: the org
 * library, its count of supporting files, search and @-mentions.
 *
 * INHERIT files come from the projects readable under DOCUMENT_READ, which is
 * the bit, any rule, team scoping and an API key's limit at once; restricted
 * ones from wherever they are filed, minus the projects a rule denies the
 * caller. `orgOnly` keeps INHERIT files to the ones filed under no project.
 */
export async function orgDocumentVisibilityWhere(ctx: AuthContext, opts: { orgOnly?: boolean } = {}) {
  const denies = ctx.abacRules.some((r) => r.effect === "deny" && r.actions?.includes(DOCUMENT_READ));
  const [readable, denied] = await Promise.all([
    opts.orgOnly ? null : getReadableProjectIds(ctx, DOCUMENT_READ).then((ids) => new Set(ids)),
    denies
      ? prisma.project
          .findMany({ where: { orgId: ctx.orgId }, select: { id: true } })
          .then((all) => projectsDenyingAction(ctx, DOCUMENT_READ, all.map((p) => p.id)))
      : new Set<string>(),
  ]);
  return documentVisibilityWhere(ctx, readable, denied);
}
