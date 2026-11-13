import { serveHeaders } from "@/lib/files/serve";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { getStorage } from "@/lib/storage";
import { handleApiError } from "@/lib/api-helpers";
import { readableDocument } from "@/lib/files/access";

type RouteParams = { params: Promise<{ orgId: string; docId: string }> };

/**
 * Stream a library document's original bytes. The library lists firm-wide
 * documents and project ones side by side, so this opens both — but a project
 * document is readable here only on the same terms as in its project. The
 * library is a view onto those documents, never a way around their gate.
 *
 * A document the actor may not see returns 404 rather than 403, matching the
 * list, which simply omits it: whether a restricted project holds a particular
 * file is itself something they should not be able to determine.
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    // The file's own rule, which already asks the project: an INHERIT file as
    // its project's document routes would (bit, rules, team scoping, a key's
    // limit), a RESTRICTED one for the people it is for, a share included. The
    // same rule GET /documents/:id, both lists and the project's download ask,
    // so a second project check here could only make this door disagree.
    if (!(await readableDocument(orgId, docId, ctx)))
      return new Response("Not found", { status: 404 });

    const doc = await prisma.document.findFirst({
      where: { id: docId, orgId },
      select: {
        storageKey: true,
        contentType: true,
        filename: true,
      },
    });
    if (!doc) return new Response("Not found", { status: 404 });

    const stream = await getStorage().stream(doc.storageKey);
    if (!stream) return new Response("File not found", { status: 404 });

    return new Response(stream, { headers: serveHeaders(doc.contentType, doc.filename) });
  } catch (e) {
    return handleApiError(e);
  }
}
