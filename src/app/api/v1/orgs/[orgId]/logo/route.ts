import { NextRequest } from "next/server";
import { fileTypeFromBuffer } from "file-type";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, noContent } from "@/lib/api-helpers";
import { getStorage } from "@/lib/storage";
import { serveHeaders } from "@/lib/files/serve";
import { LOGO_UPLOAD_TYPES, storedOrgLogo } from "@/lib/org/stored-logo";
import { patchOrgSettings } from "@/lib/org/patch-settings.server";

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
 * the feedback-attachment route. SVG is not accepted: it is a document that
 * can carry script, and the sniffer can't vouch for it.
 *
 * SERVED AS A FILE, NOT AS A PAGE. Every logo goes out with nosniff, an inline
 * disposition and a sandboxing CSP (`sandbox; default-src 'none'`), so even a
 * logo opened directly in a tab can't run script on the app's origin. SVG logos
 * uploaded before SVG was refused still display, under that same sandbox.
 *
 * The stored key is read through `storedOrgLogo`, which only accepts a key in
 * this org's `branding/` folder.
 */

const MAX_BYTES = 2 * 1024 * 1024; // a logo; anything larger is a mistake
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};
/** No script, no subresources, an opaque origin: a logo is only ever looked at. */
const LOGO_CSP = "sandbox; default-src 'none'";

type RouteParams = { params: Promise<{ orgId: string }> };

async function orgFor(orgId: string) {
  return prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true, logoUrl: true, settings: true },
  });
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
    // Only the sniffed type counts. The declared type is never consulted, so an
    // SVG (which the sniffer does not recognise) can't arrive labelled as a PNG.
    const contentType = sniffed?.mime ?? "application/octet-stream";
    if (!LOGO_UPLOAD_TYPES.has(contentType)) {
      return new Response(JSON.stringify({ error: "unsupported_mime", contentType }),
        { status: 415, headers: { "content-type": "application/json" } });
    }

    // A fresh key per upload, so a cached browser copy of the old logo can
    // never be served for the new one.
    const version = crypto.randomUUID();
    const storageKey = `${orgId}/branding/logo-${version}.${EXT[contentType]}`;
    await getStorage().put(storageKey, buffer, { contentType, filename: file.name });

    // Only the two logo keys and logoUrl are written, against the row as it is
    // now: the org read above is from before the storage upload, and writing
    // that whole settings object back would undo any other setting changed
    // meanwhile.
    const before = await prisma.$transaction(async (tx) => {
      const settingsBefore = await patchOrgSettings(
        orgId,
        { set: { logoStorageKey: storageKey, logoContentType: contentType } },
        tx,
      );
      await tx.organization.update({
        where: { id: orgId },
        data: { logoUrl: `/api/v1/orgs/${orgId}/logo?v=${version}` },
      });
      return settingsBefore;
    });
    const previous = storedOrgLogo(orgId, before)?.key ?? null;

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

    const logo = storedOrgLogo(orgId, org.settings);
    if (!logo) return new Response("Not found", { status: 404 });

    const stream = await getStorage().stream(logo.key);
    if (!stream) return new Response("Not found", { status: 404 });

    const ext = EXT[logo.contentType];
    const headers = serveHeaders(logo.contentType, ext ? `logo.${ext}` : "logo");
    headers.set("Content-Security-Policy", LOGO_CSP);
    // Immutable: the URL carries a version that changes on every upload, so
    // the bytes behind a given URL never change.
    headers.set("Cache-Control", "private, max-age=31536000, immutable");
    return new Response(stream, { headers });
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

    // Only the two logo keys and logoUrl change; see POST.
    const before = await prisma.$transaction(async (tx) => {
      const settingsBefore = await patchOrgSettings(orgId, { remove: ["logoStorageKey", "logoContentType"] }, tx);
      await tx.organization.update({ where: { id: orgId }, data: { logoUrl: null } });
      return settingsBefore;
    });
    const key = storedOrgLogo(orgId, before)?.key ?? null;
    if (key) await getStorage().delete(key).catch(() => {});

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
