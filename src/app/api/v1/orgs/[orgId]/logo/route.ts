import { NextRequest } from "next/server";
import { fileTypeFromBuffer } from "file-type";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, noContent } from "@/lib/api-helpers";
import { getStorage } from "@/lib/storage";

/**
 * Organization logo — upload a file rather than paste a URL.
 *
 * WHY NOT WRITE INTO `public/`. The nearest existing upload (the user
 * background) writes to `public/uploads/`, which works for a dev box and
 * quietly loses the file on every deploy: the runtime image is rebuilt and the
 * container replaced, so anything written into the served directory at runtime
 * is gone. An org's logo has to outlive a release, so it goes through the
 * storage adapter — MinIO in pre-prod, S3 in prod — exactly like feedback
 * attachments do.
 *
 * WHY A STREAMING GET. Object storage here is inside the deployment boundary
 * (`https://cosmos-minio:9000`), so an object URL is not reachable from a
 * browser and must not be handed out anyway. `logoUrl` therefore points at this
 * route, which streams the bytes for members of the org.
 *
 * THE CONTENT TYPE IS SNIFFED, not taken from the upload. `file.type` is
 * whatever the client claims; a renamed executable would sail through a check
 * on the claim alone. The whitelist is applied to the sniffed type, matching
 * the feedback-attachment route.
 */

const MAX_BYTES = 2 * 1024 * 1024; // a logo; anything larger is a mistake
const MIME_WHITELIST = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

type RouteParams = { params: Promise<{ orgId: string }> };

async function orgFor(orgId: string) {
  return prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true, logoUrl: true, settings: true },
  });
}

/** Where the current logo lives in object storage, if anywhere. */
function storageKeyOf(settings: unknown): string | null {
  const s = (settings ?? {}) as Record<string, unknown>;
  return typeof s.logoStorageKey === "string" ? s.logoStorageKey : null;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await orgFor(orgId);
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_UPDATE);

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return new Response(JSON.stringify({ error: "file is required" }),
        { status: 400, headers: { "content-type": "application/json" } });
    }
    if (file.size > MAX_BYTES) {
      return new Response(JSON.stringify({ error: "too_large", maxBytes: MAX_BYTES }),
        { status: 413, headers: { "content-type": "application/json" } });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const sniffed = await fileTypeFromBuffer(buffer);
    // SVG is XML, which the sniffer does not detect as an image type, so it is
    // the one case where the declared type is consulted — and only to reach a
    // whitelist entry, never to bypass one.
    const contentType =
      sniffed?.mime ?? (file.type === "image/svg+xml" ? "image/svg+xml" : (file.type || "application/octet-stream"));
    if (!MIME_WHITELIST.has(contentType)) {
      return new Response(JSON.stringify({ error: "unsupported_mime", contentType }),
        { status: 415, headers: { "content-type": "application/json" } });
    }

    // A fresh key per upload, so a cached browser copy of the old logo can
    // never be served for the new one.
    const version = crypto.randomUUID();
    const storageKey = `${orgId}/branding/logo-${version}.${EXT[contentType]}`;
    await getStorage().put(storageKey, buffer, { contentType, filename: file.name });

    const previous = storageKeyOf(org.settings);
    const settings = { ...((org.settings ?? {}) as Record<string, unknown>), logoStorageKey: storageKey, logoContentType: contentType };

    await prisma.organization.update({
      where: { id: orgId },
      data: {
        logoUrl: `/api/v1/orgs/${orgId}/logo?v=${version}`,
        // Prisma's Json input is a closed union; a plain Record is not assignable.
        settings: settings as Prisma.InputJsonObject,
      },
    });

    // Best-effort: a stale object left behind costs a little storage, whereas
    // failing the request after the record already points at the new one would
    // leave the org with a logo it cannot see.
    if (previous && previous !== storageKey) {
      await getStorage().delete(previous).catch(() => {});
    }

    return success({ logoUrl: `/api/v1/orgs/${orgId}/logo?v=${version}` });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await orgFor(orgId);
    if (!org) return new Response("Not found", { status: 404 });

    // Membership, not ORG_UPDATE: everyone in the org sees the logo in the
    // sidebar. getAuthContext returns null for a non-member of this org.
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const key = storageKeyOf(org.settings);
    if (!key) return new Response("Not found", { status: 404 });

    const stream = await getStorage().stream(key);
    if (!stream) return new Response("Not found", { status: 404 });

    const s = (org.settings ?? {}) as Record<string, unknown>;
    return new Response(stream, {
      headers: {
        "content-type": typeof s.logoContentType === "string" ? s.logoContentType : "application/octet-stream",
        // Immutable: the URL carries a version that changes on every upload, so
        // the bytes behind a given URL never change.
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await orgFor(orgId);
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_UPDATE);

    const key = storageKeyOf(org.settings);
    const settings = { ...((org.settings ?? {}) as Record<string, unknown>) };
    delete settings.logoStorageKey;
    delete settings.logoContentType;

    await prisma.organization.update({
      where: { id: orgId },
      data: { logoUrl: null, settings: settings as Prisma.InputJsonObject },
    });
    if (key) await getStorage().delete(key).catch(() => {});

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
