import { prisma } from "@/lib/db/client";

/**
 * Attendees are people in the meeting's org: an attendee can be sent an
 * Outlook invitation, so a user id from another org (or someone who left) is
 * never accepted onto a meeting.
 */
export async function allOrgMembers(orgId: string, userIds: string[]): Promise<boolean> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return true;
  const n = await prisma.orgMember.count({ where: { orgId, userId: { in: ids }, removedAt: null } });
  return n === ids.length;
}

export const attendeesNotMembers = () =>
  Response.json({ error: "Attendees must be members of this organization." }, { status: 400 });
