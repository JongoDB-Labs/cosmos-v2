import { prismaUnfiltered } from "@/lib/db/client";

import { avatarEndpointPath, avatarServable } from "./avatar-url.server";

/**
 * `avatarSrc` for many users at once, for payloads that name the same few
 * people on many rows (a board's assignees).
 *
 * Returns userId → endpoint URL for each user whose avatar the endpoint will
 * actually serve. A user missing from the map keeps their stored value: the
 * endpoint 404s an avatar it cannot decode, and 404s a user with no
 * membership row in this org (a past assignee can have none), so a URL for
 * either would be a broken image where today there is a picture.
 *
 * Decodes each distinct user's avatar once, and asks the database at most
 * once, only when there is something to swap.
 */
export async function avatarSrcs(
  orgId: string,
  users: Iterable<{ id: string; avatarUrl: string | null }>,
): Promise<Map<string, string>> {
  const servable = new Map<string, string>();
  for (const u of users) {
    if (servable.has(u.id)) continue;
    if (avatarServable(u.avatarUrl)) servable.set(u.id, u.avatarUrl);
  }
  const out = new Map<string, string>();
  if (servable.size === 0) return out;

  // Unfiltered, like the endpoint itself: a removed member's avatar still
  // resolves there, so it may be pointed at here. Read for existence only.
  const members = await prismaUnfiltered.orgMember.findMany({
    where: { orgId, userId: { in: [...servable.keys()] } },
    select: { userId: true },
  });
  for (const { userId } of members) {
    const stored = servable.get(userId);
    if (stored) out.set(userId, avatarEndpointPath(orgId, userId, stored));
  }
  return out;
}
