import { prisma } from "@/lib/db/client";
import { rateLimit } from "@/lib/rate-limit/bucket";
import { logAudit } from "@/lib/audit";
import { canAdministerProject } from "@/lib/rbac/require-project-manage";
import { createClassificationResolver } from "@/lib/classification/resolver";
import { isAllowedServiceUrl, sendToConversation, type ConnectorDeps } from "./bot-connector.server";
import { teamsUsers, type TeamsOrg } from "./identity.server";

/**
 * COSMOS-202 T2: where the bot may write, as Teams tells us in VERIFIED inbound
 * activities (the caller has checked the Bot Framework token).
 *
 * - Personal: when someone installs the bot or writes to it, their chat is
 *   remembered for each org that maps them (their own Outlook link). Nothing
 *   is sent there until they choose notifications in Preferences.
 * - Channel: a project admin types "@Cosmos link KEY" in a channel. Only for
 *   a team in the org's own tenant, a person who may administer that project,
 *   and a project that is neither restricted nor team-scoped (a channel is a
 *   wider audience than the project). Rate limited per channel.
 * - Anything else typed to the bot gets fixed help text. What was typed is
 *   never echoed back and never read as anything but the fixed grammar.
 */

export interface InboundActivity {
  type?: string;
  text?: string;
  serviceUrl?: string;
  from?: { aadObjectId?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  channelData?: { tenant?: { id?: string }; team?: { id?: string } };
}

export type Command = { kind: "link"; key: string } | { kind: "unlink" } | { kind: "help" };

/** The fixed grammar, after Teams' <at>mention</at> of the bot is removed. Everything else is help. */
export function parseCommand(text: string | undefined): Command {
  const t = (text ?? "").replace(/<at>[^<]*<\/at>/gi, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const link = /^link ([A-Za-z][A-Za-z0-9_]{0,19})$/i.exec(t);
  if (link) return { kind: "link", key: link[1].toUpperCase() };
  if (/^unlink$/i.test(t)) return { kind: "unlink" };
  return { kind: "help" };
}

/** A channel post's conversation id names the thread it is in; the channel is what comes before ";messageid=". */
export const channelConversationId = (id: string) => id.split(";")[0];

const sameTenant = (a: string | undefined, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

export const PERSONAL_HELP =
  "I send your Cosmos notifications here. Choose which ones in Cosmos: Settings, Preferences, Teams notifications.";
export const CHANNEL_HELP =
  "I post a Cosmos project's updates to this channel. A project admin types: @Cosmos link KEY (the project's key). To stop: @Cosmos unlink.";

async function reply(a: InboundActivity, tenantId: string, text: string, deps: ConnectorDeps) {
  if (!a.conversation?.id || !isAllowedServiceUrl(a.serviceUrl)) return;
  await sendToConversation({ tenantId, serviceUrl: a.serviceUrl, conversationId: a.conversation.id }, { text }, deps).catch(() => undefined);
}

/**
 * Remember a person's chat with the bot, for every org Cosmos maps them in.
 * Returns how many were stored. A serviceUrl that isn't Microsoft's commercial
 * Bot Connector is refused (and audited): GCC High and DoD are out of scope.
 */
export async function capturePersonal(a: InboundActivity, tenantId: string, orgs: TeamsOrg[]): Promise<number> {
  const conversationId = a.conversation?.id;
  if (a.conversation?.conversationType !== "personal" || !conversationId) return 0;
  const users = await teamsUsers(orgs, tenantId, a.from?.aadObjectId ?? "");
  if (!users.length) return 0;
  if (!isAllowedServiceUrl(a.serviceUrl)) {
    for (const u of users) {
      await logAudit({
        orgId: u.orgId, userId: u.userId, action: "teams.conversation_refused", entity: "teams_conversation",
        metadata: { reason: "service_url_not_commercial" },
      });
    }
    return 0;
  }
  for (const u of users) {
    await prisma.teamsConversation.upsert({
      where: { orgId_userId: { orgId: u.orgId, userId: u.userId } },
      create: { orgId: u.orgId, userId: u.userId, tenantId, serviceUrl: a.serviceUrl, conversationId },
      update: { tenantId, serviceUrl: a.serviceUrl, conversationId },
    });
  }
  return users.length;
}

/** A personal message to the bot: remember the chat, answer with help. */
export async function handlePersonalMessage(a: InboundActivity, tenantId: string, orgs: TeamsOrg[], deps: ConnectorDeps = {}) {
  await capturePersonal(a, tenantId, orgs);
  await reply(a, tenantId, PERSONAL_HELP, deps);
}

const LINK_LIMIT = { capacity: 5, refillPerSecond: 5 / 3600 };

/** "@Cosmos link KEY" / "@Cosmos unlink" / anything else, in a channel. */
export async function handleChannelMessage(a: InboundActivity, tenantId: string, orgs: TeamsOrg[], deps: ConnectorDeps = {}): Promise<string> {
  const say = (text: string) => reply(a, tenantId, text, deps);
  const cmd = parseCommand(a.text);
  if (cmd.kind === "help" || !a.conversation?.id) {
    await say(CHANNEL_HELP);
    return "help";
  }
  const channel = channelConversationId(a.conversation.id);
  if (!rateLimit(`teams-link:${channel}`, LINK_LIMIT).allowed) {
    await say("Too many link changes for this channel. Try again later.");
    return "rate_limited";
  }
  // The team, the conversation and the org must all be in the org's pinned tenant.
  if (!sameTenant(a.channelData?.tenant?.id, tenantId) || !sameTenant(a.conversation.tenantId ?? a.channelData?.tenant?.id, tenantId)) {
    await say("This team isn't in your organization's Microsoft tenant.");
    return "wrong_tenant";
  }
  if (!isAllowedServiceUrl(a.serviceUrl)) return "service_url_refused";
  const users = await teamsUsers(orgs, tenantId, a.from?.aadObjectId ?? "");
  if (!users.length) {
    await say("Cosmos doesn't know who you are yet: connect Outlook Calendar in Cosmos (Settings, Preferences) first.");
    return "not_connected";
  }

  if (cmd.kind === "unlink") {
    const links = await prisma.teamsConversation.findMany({
      where: { orgId: { in: users.map((u) => u.orgId) }, projectId: { not: null }, conversationId: channel },
      select: { id: true, orgId: true, projectId: true },
    });
    let removed = 0;
    for (const l of links) {
      const u = users.find((x) => x.orgId === l.orgId)!;
      if (!(await canAdministerProject(u.auth, l.projectId!))) continue;
      await prisma.teamsConversation.delete({ where: { id: l.id } });
      await logAudit({ orgId: l.orgId, userId: u.userId, action: "teams.channel_unlinked", entity: "project", entityId: l.projectId! });
      removed++;
    }
    await say(removed ? "This channel no longer gets Cosmos updates." : "No project you administer is linked to this channel.");
    return removed ? "unlinked" : "nothing_to_unlink";
  }

  // link KEY
  // SCOPING NOTE: not a listing. One key's projects, in the orgs this person is
  // mapped in, each kept only if canAdministerProject(their own auth) passes
  // below; one they can't administer reads the same as a missing key.
  const candidates = await prisma.project.findMany({
    where: { orgId: { in: users.map((u) => u.orgId) }, key: { equals: cmd.key, mode: "insensitive" }, archived: false },
    select: { id: true, orgId: true, key: true, name: true, teamScopedAccess: true },
  });
  for (const p of candidates) {
    const u = users.find((x) => x.orgId === p.orgId)!;
    if (!(await canAdministerProject(u.auth, p.id))) continue;
    const cls = await createClassificationResolver(p.orgId);
    if (cls.restricted(p.id, p.name) || p.teamScopedAccess) {
      await say(`${p.key} can't be linked to a channel: it's restricted, and a channel reaches more people than the project.`);
      return "restricted";
    }
    const last = await prisma.domainEvent.findFirst({ orderBy: { id: "desc" }, select: { id: true } });
    await prisma.teamsConversation.upsert({
      where: { orgId_projectId: { orgId: p.orgId, projectId: p.id } },
      create: { orgId: p.orgId, projectId: p.id, tenantId, serviceUrl: a.serviceUrl, conversationId: channel, lastEventId: last?.id ?? 0n },
      update: { tenantId, serviceUrl: a.serviceUrl, conversationId: channel, lastEventId: last?.id ?? 0n },
    });
    await logAudit({ orgId: p.orgId, userId: u.userId, action: "teams.channel_linked", entity: "project", entityId: p.id });
    await say(`Linked: this channel gets ${p.key}'s new items and status changes.`);
    return "linked";
  }
  // Not found and not allowed read the same.
  await say("No project with that key that you administer.");
  return "not_found";
}

/**
 * The bot was uninstalled from this chat or team: forget that conversation.
 * (A channel elsewhere in an uninstalled team is forgotten on its next send,
 * when the Bot Connector answers 403.)
 */
export async function forgetConversation(a: InboundActivity, orgs: TeamsOrg[]) {
  if (!a.conversation?.id || !orgs.length) return 0;
  const r = await prisma.teamsConversation.deleteMany({
    where: { orgId: { in: orgs.map((o) => o.orgId) }, conversationId: channelConversationId(a.conversation.id) },
  });
  return r.count;
}

/** The Teams app was switched off: forget every conversation in the org. */
export async function forgetOrgConversations(orgId: string) {
  await prisma.teamsConversation.deleteMany({ where: { orgId } });
}
