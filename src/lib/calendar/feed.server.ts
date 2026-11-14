import { prisma } from "@/lib/db/client";
import { getBrand } from "@/lib/brand";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { isProjectVisible } from "@/lib/rbac/project-access";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { readableMeetingsWhere } from "@/lib/meetings/meeting-reader";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { createClassificationResolver } from "@/lib/classification/resolver";
import { requiredIdpConnectionId } from "@/lib/auth/sso-enforcement";
import type { AuthContext } from "@/lib/rbac/check";
import { buildIcs } from "./ics";
import { feedEvents } from "./feed-events";
import { calendarFeedsEnabled, feedInactiveReason, readFeedOptions, type FeedStanding } from "./feed-settings";
import { hashFeedToken } from "./feed-token";

const DAY = 86_400_000;
/** The window a feed covers, and the most events it carries. */
export const FEED_PAST_DAYS = 30;
export const FEED_FUTURE_DAYS = 180;
export const FEED_MAX_EVENTS = 500;

export interface RenderedFeed {
  feedId: string;
  ics: string;
  lastModified: Date;
}

/** The org's rules today, for feedInactiveReason. */
export async function loadFeedStanding(org: { id: string; settings: unknown }): Promise<FeedStanding> {
  return { enabled: calendarFeedsEnabled(org.settings), requiredIdpConnId: await requiredIdpConnectionId(org.id) };
}

/**
 * The feed behind a token, or null for ANY reason it shouldn't be served: an
 * unknown or revoked token, a deactivated or removed person, or a link the
 * org's rules stop (feedInactiveReason: feeds switched off, or a link the
 * org's single sign-on doesn't vouch for). The route turns null into a bare 404, so a caller learns
 * nothing about which check failed.
 *
 * Access is re-derived on every fetch from the person's CURRENT membership,
 * exactly as if they were signed in, and each item's project is checked for
 * read access, so losing access to a project drops its work from the feed on
 * the next refresh.
 */
export async function renderFeed(token: string, args: { origin: string; now?: Date }): Promise<RenderedFeed | null> {
  const feed = await prisma.calendarFeed.findUnique({
    where: { tokenHash: hashFeedToken(token) },
    include: {
      org: { select: { id: true, slug: true, name: true, settings: true } },
      user: { select: { id: true, displayName: true, deactivatedAt: true } },
    },
  });
  if (!feed || feed.revokedAt || feed.user.deactivatedAt) return null;
  if (feedInactiveReason(await loadFeedStanding(feed.org), feed) !== null) return null;
  const { orgId, userId } = feed;
  // forApiKey: no OWNER break-glass, so the org's restrictions bind an
  // owner's link as they bind an owner's API key.
  const eff = await loadEffectivePermissions(orgId, userId, { forApiKey: true });
  if (!eff) return null;
  const ctx: AuthContext = {
    userId,
    orgId,
    orgRole: eff.orgRole,
    permissions: eff.permissions,
    basePermissions: eff.basePermissions,
    abacRules: eff.abacRules,
    // Not a person at a keyboard: no OWNER break-glass for a feed.
    isApiKey: true,
  };

  const now = args.now ?? new Date();
  const from = new Date(now.getTime() - FEED_PAST_DAYS * DAY);
  const to = new Date(now.getTime() + FEED_FUTURE_DAYS * DAY);
  const options = readFeedOptions(feed.options);
  const can = (p: bigint) => hasPermission(ctx.permissions, p);

  // Work items through the same gate as the issue list: the projects this
  // person may read work items from, ABAC denies included.
  const itemProjects =
    options.workItems && can(Permission.ITEM_READ) ? await getReadableProjectIds(ctx) : [];
  const workItems =
    itemProjects.length > 0
      ? await prisma.workItem.findMany({
          where: {
            orgId,
            projectId: { in: itemProjects },
            archivedAt: null,
            OR: [{ assigneeId: userId }, { assignees: { some: { userId } } }],
            AND: [
              { OR: [{ dueDate: { not: null } }, { startDate: { not: null } }] },
              { OR: [{ dueDate: { gte: from } }, { dueDate: null, startDate: { gte: from } }] },
              { OR: [{ startDate: { lte: to } }, { startDate: null, dueDate: { lte: to } }] },
            ],
          },
          select: {
            id: true, ticketNumber: true, title: true, description: true, startDate: true, dueDate: true,
            updatedAt: true, projectId: true,
          },
          orderBy: { dueDate: "asc" },
          take: FEED_MAX_EVENTS,
        })
      : [];

  const meetings =
    options.meetings && can(Permission.MEETING_READ)
      ? await prisma.syncMeeting.findMany({
          where: {
            // The one meeting-read rule every meeting door uses: MEETING_READ
            // (bit and policy) and, under a project, that project visible.
            AND: [await readableMeetingsWhere(ctx)],
            orgId,
            status: { not: "CANCELLED" },
            meetingDate: { gte: from, lte: to },
            attendees: { some: { userId } },
          },
          select: { id: true, title: true, meetingDate: true, updatedAt: true, projectId: true, teamsJoinUrl: true, meetingUrl: true },
          orderBy: { meetingDate: "asc" },
          take: FEED_MAX_EVENTS,
        })
      : [];

  const intervals =
    options.intervals && can(Permission.SPRINT_READ)
      ? await prisma.interval.findMany({
          where: {
            orgId,
            startDate: { lte: to },
            endDate: { gte: from },
            project: { members: { some: { orgMember: { userId, orgId } } } },
          },
          // No updatedAt: an Interval has none, and asking for it failed
          // every feed that included sprints.
          select: {
            id: true, name: true, goal: true, startDate: true, endDate: true,
            projectId: true, project: { select: { key: true } },
          },
          orderBy: { startDate: "asc" },
          take: FEED_MAX_EVENTS,
        })
      : [];

  // Sprints: the project must still be one this person can see (team-scoped
  // projects), checked once per project. Meetings were read by their own rule.
  const otherProjects = [
    ...new Set(intervals.map((r) => r.projectId).filter((p): p is string => !!p)),
  ];
  const seen = new Set<string>();
  for (const pid of otherProjects) if (await isProjectVisible(ctx, pid)) seen.add(pid);
  const visible = <T extends { projectId: string | null }>(r: T) => !r.projectId || seen.has(r.projectId);
  const keys = new Map(
    (await prisma.project.findMany({ where: { id: { in: [...new Set(workItems.map((w) => w.projectId))] } }, select: { id: true, key: true } })).map(
      (p) => [p.id, p.key] as const,
    ),
  );

  // Classification: a project (or org) whose ceiling carries a marking, or a
  // marking in the row's own text, makes the row busy-only.
  const { restricted } = await createClassificationResolver(orgId);

  const events = feedEvents({
    options,
    origin: args.origin,
    orgSlug: feed.org.slug,
    uidHost: new URL(args.origin).host,
    workItems: workItems.map((w) => ({
      id: w.id, ticketNumber: w.ticketNumber, projectKey: keys.get(w.projectId) ?? "", title: w.title,
      startDate: w.startDate, dueDate: w.dueDate, updatedAt: w.updatedAt,
      restricted: restricted(w.projectId, w.title, w.description),
    })),
    meetings: meetings.map((m) => ({
      id: m.id, title: m.title, meetingDate: m.meetingDate, updatedAt: m.updatedAt,
      // Null unless it is a Teams meeting: the database drops the link of a
      // meeting with no host (trigger sync_meetings_teams_link_needs_host).
      teamsJoinUrl: m.teamsJoinUrl,
      meetingUrl: m.meetingUrl,
      // The link is judged with the title, as the Outlook sync judges it: a
      // marking in either makes the row busy.
      restricted: restricted(m.projectId, m.title, m.meetingUrl),
    })),
    intervals: intervals.filter(visible).map((i) => ({
      id: i.id, name: i.name, projectKey: i.project.key, startDate: i.startDate, endDate: i.endDate,
      updatedAt: null, restricted: restricted(i.projectId, i.name, i.goal),
    })),
  }).slice(0, FEED_MAX_EVENTS);

  // Stamped with the newest change, not the clock, so an unchanged feed is
  // byte-identical and its ETag lets the calendar skip the download.
  const lastModified = new Date(
    Math.max(feed.createdAt.getTime(), ...events.map((e) => e.lastModified?.getTime() ?? 0)),
  );
  const brand = getBrand().name;
  const ics = buildIcs({
    prodId: `-//${brand}//Calendar feed//EN`,
    name: `${brand}: ${feed.org.name}`,
    stamp: lastModified,
    events,
  });

  void prisma.calendarFeed.update({ where: { id: feed.id }, data: { lastFetchedAt: now } }).catch(() => {});
  return { feedId: feed.id, ics, lastModified };
}
