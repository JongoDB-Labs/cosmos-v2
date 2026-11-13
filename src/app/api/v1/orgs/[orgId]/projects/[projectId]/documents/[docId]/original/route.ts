import { serveHeaders } from "@/lib/files/serve";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/rbac/check";
import { getStorage } from "@/lib/storage";
import { handleApiError } from "@/lib/api-helpers";
import { readableProjectDocument } from "@/lib/files/access";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; docId: string }>;
};

/**
 * Stream the stored ORIGINAL file (for "view original" — PDF inline, others download).
 *
 * The file's own rule decides, and it asks the project too (lib/files/access.ts):
 * the same answer as the org library's download, so a file shared with somebody
 * outside a team-scoped project downloads for them on both. Anything it refuses
 * is the same 404 as a file that does not exist, here as on the org's download.
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    if (!(await readableProjectDocument(orgId, projectId, docId, ctx)))
      return new Response("Not found", { status: 404 });

    const doc = await prisma.document.findFirst({
      where: { id: docId, orgId, projectId },
      select: { storageKey: true, contentType: true, filename: true },
    });
    if (!doc) return new Response("Not found", { status: 404 });

    const stream = await getStorage().stream(doc.storageKey);
    if (!stream) return new Response("File not found", { status: 404 });

    return new Response(stream, { headers: serveHeaders(doc.contentType, doc.filename) });
  } catch (e) {
    // A refusal from anywhere below is a missing file to this caller, never a 500.
    if (e instanceof ForbiddenError) return new Response("Not found", { status: 404 });
    return handleApiError(e);
  }
}
