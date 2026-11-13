import { Prisma, type SlackLinkStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { lookupByEmail, SlackApiError, type SlackDeps } from "./web-api.server";
import { isSlackNotifyType, type SlackNotifyType } from "./config";

/**
 * Linking a Cosmos member to a Slack user, per org.
 *
 * Only by email, and only when Slack says that person CONFIRMED that email
 * (`is_email_confirmed`): an unconfirmed address is one anybody could have
 * typed into their Slack profile. The Slack user must be in the org's
 * workspace, not deleted and not a bot.
 *
 * Two Cosmos members can share an email (it isn't unique), so one Slack user
 * can match two members. The first is linked; any further one waits as
 * NEEDS_REVIEW, sending nothing, until an admin allows it. A partial unique
 * index (slack_user_links_one_unapproved) holds that even when two matches race.
 *
 * A member who unlinks is never matched again automatically, only when they
 * (or an admin) ask.
 */

export interface MatchResult {
  status: SlackLinkStatus;
  /** Why it isn't LINKED, in a word the screens turn into a sentence. */
  reason?: "not_found" | "unconfirmed" | "conflict" | "unlinked" | "no_email";
}

const sameEmail = (a: string | undefined, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

interface LinkData {
  status: SlackLinkStatus;
  slackTeamId?: string | null;
  slackUserId?: string | null;
  approvedById?: string | null;
  linkedAt?: Date | null;
  checkedAt?: Date | null;
}

async function save(orgId: string, userId: string, data: LinkData) {
  await prisma.slackUserLink.upsert({
    where: { orgId_userId: { orgId, userId } },
    create: { orgId, userId, ...data },
    update: data,
  });
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/**
 * Look the member up in Slack by their Cosmos email and record what was
 * found. `explicit` is a person asking (the member, or an admin's "match
 * members"): it may relink someone who unlinked when it's the member
 * themselves. Throws SlackApiError for anything but "no such user".
 */
export async function matchMember(
  o: { orgId: string; userId: string; token: string; teamId: string; now?: Date; relinkUnlinked?: boolean },
  deps?: SlackDeps,
): Promise<MatchResult> {
  const now = o.now ?? new Date();
  const existing = await prisma.slackUserLink.findUnique({ where: { orgId_userId: { orgId: o.orgId, userId: o.userId } }, select: { status: true } });
  if (existing?.status === "UNLINKED" && !o.relinkUnlinked) return { status: "UNLINKED", reason: "unlinked" };
  const user = await prisma.user.findUnique({ where: { id: o.userId }, select: { email: true } });
  const email = user?.email?.trim();
  const noMatch = async (reason: MatchResult["reason"]): Promise<MatchResult> => {
    await save(o.orgId, o.userId, { status: "NO_MATCH", slackTeamId: null, slackUserId: null, approvedById: null, linkedAt: null, checkedAt: now });
    return { status: "NO_MATCH", reason };
  };
  if (!email) return noMatch("no_email");

  let found;
  try {
    found = await lookupByEmail(o.token, email, deps);
  } catch (e) {
    if (e instanceof SlackApiError && e.code === "users_not_found") return noMatch("not_found");
    throw e;
  }
  if (found.deleted || found.is_bot || (found.team_id && found.team_id !== o.teamId) || !sameEmail(found.profile?.email, email)) {
    return noMatch("not_found");
  }
  if (found.is_email_confirmed !== true) return noMatch("unconfirmed");

  const base = { slackTeamId: o.teamId, slackUserId: found.id, checkedAt: now, linkedAt: now, approvedById: null };
  const taken = await prisma.slackUserLink.findFirst({
    where: { orgId: o.orgId, slackUserId: found.id, userId: { not: o.userId }, status: { in: ["LINKED", "NEEDS_REVIEW"] } },
    select: { id: true },
  });
  if (taken) {
    await save(o.orgId, o.userId, { ...base, status: "NEEDS_REVIEW" });
    return { status: "NEEDS_REVIEW", reason: "conflict" };
  }
  try {
    await save(o.orgId, o.userId, { ...base, status: "LINKED" });
    return { status: "LINKED" };
  } catch (e) {
    // Another member was linked to this Slack user a moment ago.
    if (!isUniqueViolation(e)) throw e;
    await save(o.orgId, o.userId, { ...base, status: "NEEDS_REVIEW" });
    return { status: "NEEDS_REVIEW", reason: "conflict" };
  }
}

export interface MatchAllResult {
  linked: number;
  review: number;
  notFound: number;
  /** Members not reached this time (Slack asked us to slow down); run it again. */
  remaining: number;
}

const MATCH_ALL_MAX = 200;

/**
 * An admin's "Match members by email": every active, human member who isn't
 * linked yet and didn't unlink, one lookup each, stopping politely at Slack's
 * rate limit. Never touches someone who unlinked.
 */
export async function matchAllMembers(
  o: { orgId: string; token: string; teamId: string; now?: Date },
  deps?: SlackDeps,
): Promise<MatchAllResult> {
  const members = await prisma.orgMember.findMany({
    where: { orgId: o.orgId, user: { deactivatedAt: null, isBot: false } },
    select: { userId: true },
    orderBy: { joinedAt: "asc" },
  });
  const links = await prisma.slackUserLink.findMany({ where: { orgId: o.orgId }, select: { userId: true, status: true } });
  const settled = new Set(links.filter((l) => l.status !== "NO_MATCH").map((l) => l.userId));
  const todo = members.map((m) => m.userId).filter((id) => !settled.has(id));
  const out: MatchAllResult = { linked: 0, review: 0, notFound: 0, remaining: 0 };
  for (let i = 0; i < todo.length; i++) {
    if (i >= MATCH_ALL_MAX) {
      out.remaining = todo.length - i;
      break;
    }
    try {
      const r = await matchMember({ orgId: o.orgId, userId: todo[i], token: o.token, teamId: o.teamId, now: o.now }, deps);
      if (r.status === "LINKED") out.linked++;
      else if (r.status === "NEEDS_REVIEW") out.review++;
      else out.notFound++;
    } catch (e) {
      if (e instanceof SlackApiError && e.retryable) {
        out.remaining = todo.length - i;
        break;
      }
      throw e;
    }
  }
  return out;
}

/** The member's (or an admin's) unlink: nothing more is sent, and no automatic relink. */
export async function unlinkMember(orgId: string, userId: string) {
  await save(orgId, userId, { status: "UNLINKED", slackTeamId: null, slackUserId: null, approvedById: null, linkedAt: null });
}

/**
 * An admin allows a member waiting on a shared Slack user. Only a row that
 * is waiting, in this org, and only to the Slack user it matched.
 */
export async function approveLink(orgId: string, linkId: string, adminId: string): Promise<boolean> {
  const r = await prisma.slackUserLink.updateMany({
    // Never an admin's own link: someone else decides who gets their notifications.
    where: { id: linkId, orgId, status: "NEEDS_REVIEW", slackUserId: { not: null }, userId: { not: adminId } },
    data: { status: "LINKED", approvedById: adminId },
  });
  return r.count === 1;
}

/** What the member chose to get in Slack. Kept even before they're matched. */
export async function setNotifyTypes(orgId: string, userId: string, types: SlackNotifyType[]) {
  const notifyTypes = [...new Set(types.filter(isSlackNotifyType))];
  await prisma.slackUserLink.upsert({
    where: { orgId_userId: { orgId, userId } },
    create: { orgId, userId, status: "NO_MATCH", notifyTypes },
    update: { notifyTypes },
  });
}
