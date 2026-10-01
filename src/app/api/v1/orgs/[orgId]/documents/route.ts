import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requirePermission } from "@/lib/rbac/check";
import { visibleProjectIdsForActor } from "@/lib/rbac/project-access";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { ingestDocument } from "@/lib/files/ingest";
import { formatFromName } from "@/lib/files/parsers";

type RouteParams = { params: Promise<{ orgId: string }> };

// Raw-bytes upload payload, mirroring the project route: API-key clients (the
// MCP server) cannot send multipart.
const jsonUploadSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  dataBase64: z.string().min(1),
  title: z.string().optional(),
});

/**
 * The org's library: documents that belong to no project — templates, standard
 * details, certificates — listed alongside the project documents the actor may
 * already see.
 *
 * The narrowing is the whole point of this route. A per-project list is scoped
 * by the project in its own URL; an org-wide one has no such anchor, so it would
 * otherwise become a side door onto a team-scoped job — every filename and title
 * on a restricted project, disclosed to anyone who can read the org. Project
 * documents are therefore filtered to the visible set IN the query, and
 * org-wide ones (which belong to nobody in particular) are visible to any org
 * reader. `?scope=org` asks for only the unattached ones; `?scope=firm` is
 * accepted as the former spelling, since this is a versioned public route and
 * something outside this repository may still send it.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const scope = req.nextUrl.searchParams.get("scope");
    const orgOnly = scope === "org" || scope === "firm";

    const all = await prisma.project.findMany({ where: { orgId }, select: { id: true } });
    const visible = await visibleProjectIdsForActor(
      orgId,
      ctx.userId,
      all.map((p) => p.id),
    );

    const docs = await prisma.document.findMany({
      where: {
        orgId,
        ...(orgOnly
          ? { projectId: null }
          : { OR: [{ projectId: null }, { projectId: { in: [...visible] } }] }),
      },
      select: {
        id: true,
        title: true,
        filename: true,
        format: true,
        status: true,
        pageCount: true,
        size: true,
        classificationLevel: true,
        contentType: true,
        createdAt: true,
        projectId: true,
        project: { select: { key: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return success(docs);
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * Add a document to the org library. Putting something here says it applies to
 * the practice rather than to a job, which is an org-level act — hence
 * ORG_UPDATE, not the project author's PROJECT_UPDATE.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_UPDATE);

    let filename: string;
    let contentType: string;
    let buffer: Buffer;
    let title: string | undefined;

    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = jsonUploadSchema.parse(await req.json());
      filename = body.filename;
      contentType = body.contentType;
      // Reject before decoding so we never allocate a huge buffer — same bound
      // as the project route: ~33.5 MB of base64 decodes to ~25 MB.
      if (body.dataBase64.length > 34_000_000)
        return new Response("File exceeds 25 MB limit", { status: 413 });
      buffer = Buffer.from(body.dataBase64, "base64");
      title = body.title;
    } else {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return new Response("Missing file field", { status: 400 });
      filename = file.name;
      contentType = file.type || "application/octet-stream";
      buffer = Buffer.from(await file.arrayBuffer());
    }

    if (!formatFromName(filename)) return new Response("Unsupported file type", { status: 400 });

    const doc = await ingestDocument({
      orgId,
      projectId: null,
      uploadedById: ctx.userId,
      filename,
      contentType,
      buffer,
      title,
    });
    return success(doc, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
