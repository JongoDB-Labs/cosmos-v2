import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { syncMeetingSoon } from "@/lib/integrations/microsoft/calendar-sync.server";

/** What the caller wants back, in Prisma's own terms. A `select` must include the id the push needs. */
type MeetingShape =
  | { select: Prisma.SyncMeetingSelect & { id: true } }
  | { include: Prisma.SyncMeetingInclude };

/**
 * Create a meeting, then push it to Outlook: the one create path, for the app
 * and for Cosmo alike. A meeting saved any other way reached nobody's calendar
 * until the next reconcile, which is what Cosmo's did. The push is
 * fire-and-forget, as every push is (`syncMeetingSoon`), so a slow or failing
 * Microsoft never fails the create. `create-meeting.arch.test.ts` keeps every
 * other `syncMeeting.create` out of the app.
 */
export async function createSyncMeeting<S extends MeetingShape>(
  data: Prisma.SyncMeetingUncheckedCreateInput,
  shape: S,
): Promise<Prisma.SyncMeetingGetPayload<S>> {
  // Prisma can't narrow a generic select-or-include, so the row is typed back
  // to the shape the caller asked for here, once.
  const meeting = await prisma.syncMeeting.create({ data, ...shape } as Prisma.SyncMeetingCreateArgs);
  syncMeetingSoon(data.orgId, meeting.id);
  return meeting as unknown as Prisma.SyncMeetingGetPayload<S>;
}
