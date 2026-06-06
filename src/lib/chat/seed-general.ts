import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * Ensure an org has a `#general` channel. Idempotent. Returns the channel id.
 *
 * `creatorUserId` is recorded as `createdById`. Pass the user creating the org
 * (or any OrgMember of that org — falls back gracefully).
 */
export async function ensureGeneralChannel(
  orgId: string,
  creatorUserId: string,
): Promise<string> {
  const existing = await prisma.chatChannel.findFirst({
    where: { orgId, isGeneral: true },
    select: { id: true },
  });
  if (existing) return existing.id;
  try {
    const channel = await prisma.chatChannel.create({
      data: {
        orgId,
        kind: "CHANNEL",
        name: "general",
        slug: "general",
        isGeneral: true,
        isPrivate: false,
        createdById: creatorUserId,
      },
      select: { id: true },
    });
    return channel.id;
  } catch (e) {
    // Lost a race with a concurrent create: re-fetch the winner.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const row = await prisma.chatChannel.findFirst({
        where: { orgId, isGeneral: true },
        select: { id: true },
      });
      if (row) return row.id;
    }
    throw e;
  }
}

/**
 * Auto-join a user to their org's `#general` channel. Idempotent: silently
 * does nothing if the user is already a member, or if no `#general` exists yet.
 *
 * `isAdmin` should be true when the OrgMember's role is OWNER or ADMIN — those
 * users get channel ADMIN, others get MEMBER.
 */
export async function autoJoinGeneral(
  orgId: string,
  userId: string,
  isAdmin: boolean,
): Promise<void> {
  const general = await prisma.chatChannel.findFirst({
    where: { orgId, isGeneral: true },
    select: { id: true },
  });
  if (!general) return;
  await prisma.chatChannelMember.upsert({
    where: { channelId_userId: { channelId: general.id, userId } },
    update: {},
    create: {
      channelId: general.id,
      userId,
      role: isAdmin ? "ADMIN" : "MEMBER",
    },
  });
}
