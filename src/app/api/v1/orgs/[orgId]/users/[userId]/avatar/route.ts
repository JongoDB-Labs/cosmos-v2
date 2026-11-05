import { NextRequest } from "next/server";

import { handleApiError } from "@/lib/api-helpers";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { orgContext } from "@/lib/openapi/org-context";
import { decodeAvatarDataUri } from "@/lib/users/avatar-url.server";

import { getUserAvatar } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; userId: string }> };

/**
 * Serve one user's avatar as image bytes.
 *
 * Avatars are stored as `data:` URIs. Inlined in every payload that names a
 * user, three of them were 93% of a 171KB members response, and base64 does
 * not compress. `avatarSrc()` points `avatarUrl` here instead, so the bytes
 * travel once and the browser reuses them wherever that user appears.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, userId } = await params;

    // The chokepoint: validates orgId, 404s an unknown org, 401s without a
    // session, and asserts the contract's scopes against an API key. Reached
    // through here rather than by hand so the `read` scope this operation
    // declares is actually enforced — a key that can list members can fetch
    // the avatars that list points at, and nothing else gets in.
    await orgContext(orgId, getUserAvatar);

    // The SUBJECT must belong to this org too. Without this, the orgId in the
    // path would gate only the caller, and a member of any org could read any
    // user's avatar anywhere by guessing a user id.
    //
    // Unfiltered deliberately: a removed member's face still sits on the
    // comments and history they left behind, which this caller can already
    // see, so their avatar has to keep resolving. The default client hides
    // `removedAt` rows and would 404 them into broken images.
    const member = await prismaUnfiltered.orgMember.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { userId: true },
    });
    if (!member) return new Response("Not found", { status: 404 });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } });
    // Only `data:` avatars are served from here. An absolute http(s) avatar is
    // handed to the browser unchanged by `avatarSrc()`, so it never asks us for
    // one — and redirecting to a stored value would make this an open redirect.
    const decoded = user?.avatarUrl ? decodeAvatarDataUri(user.avatarUrl) : null;
    if (!decoded) return new Response("Not found", { status: 404 });

    return new Response(decoded.bytes, {
      headers: {
        "content-type": decoded.contentType,
        "content-length": String(decoded.bytes.byteLength),
        // The content type comes from a stored, user-supplied string. The
        // decoder allowlists raster images, and this stops a browser from
        // sniffing its way to any other conclusion.
        "x-content-type-options": "nosniff",
        // Immutable is safe because `avatarSrc()` versions the URL by a hash of
        // the content, so the bytes behind a given URL never change. Private
        // because an avatar is visible to this org, not to shared caches.
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
