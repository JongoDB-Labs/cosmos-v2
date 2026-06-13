import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { ingestDocument } from "@/lib/files/ingest";
import { formatFromName } from "@/lib/files/parsers";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

// Raw-bytes upload payload (used by the MCP server / API-key clients that can't
// send multipart). Mirrors the multipart path: filename drives the format check.
const jsonUploadSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  dataBase64: z.string().min(1),
  title: z.string().optional(),
});

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    const docs = await prisma.document.findMany({
      where: { orgId, projectId },
      select: {
        id: true, title: true, filename: true, format: true, status: true,
        pageCount: true, size: true, classificationLevel: true, contentType: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return success(docs);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);
    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    // Two intake shapes converge on the SAME ingest call: a browser multipart
    // upload, or a JSON {filename, contentType, dataBase64, title?} body for
    // API-key clients (e.g. the MCP server) that can't send multipart.
    let filename: string;
    let contentType: string;
    let buffer: Buffer;
    let title: string | undefined;

    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = jsonUploadSchema.parse(await req.json());
      filename = body.filename;
      contentType = body.contentType;
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

    // Format guard (multipart parity) before the shared ingest call; the 25 MB
    // size cap is enforced inside ingestDocument for both paths.
    if (!formatFromName(filename)) return new Response("Unsupported file type", { status: 400 });

    const doc = await ingestDocument({
      orgId,
      projectId,
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
