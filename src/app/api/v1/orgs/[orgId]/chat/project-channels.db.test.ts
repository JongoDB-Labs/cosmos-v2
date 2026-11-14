// @vitest-environment node
//
// A chat channel tied to a project followed the channel's own rules only, so a
// member who could not see a team-scoped project could still list, browse,
// join, read, search and post to that project's channel, and kept getting its
// messages as notifications. The channel now follows the project: someone who
// can't see the project can't see its channel, however they came to be in it,
// and an org owner or admin, who sees every project, still does.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";

const h = vi.hoisted(() => ({ ctx: null as unknown, agentRuns: 0 }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
// Cosmo's in-channel bot: count the runs that reach the model, never call one.
vi.mock("@/lib/ai/agent-loop", () => ({
  runAgentLoop: async () => {
    h.agentRuns++;
    return { text: "NO_GROUNDED_ANSWER", transcript: "" };
  },
}));
vi.mock("@/lib/chat/ensure-bots", () => {
  const bot = (id: string) => ({ user: { id }, toolScope: "READONLY", persona: "", model: "sonnet" });
  return {
    ensureOrgBots: async () => ({
      assistant: bot(randomUUID()),
      notetaker: bot(randomUUID()),
      answerer: bot(randomUUID()),
      standup: bot(randomUUID()),
    }),
  };
});

import { GET as listChannels } from "./channels/route";
import { GET as browse } from "./channels/browse/route";
import { GET as channelDetail } from "./channels/[channelId]/route";
import { GET as messages, POST as postMessage } from "./channels/[channelId]/messages/route";
import { GET as replies } from "./channels/[channelId]/messages/[messageId]/replies/route";
import { GET as pins, POST as pin } from "./channels/[channelId]/pins/route";
import { GET as readState } from "./channels/[channelId]/read-state/route";
import { GET as roster } from "./channels/[channelId]/members/route";
import { POST as join } from "./channels/[channelId]/join/route";
import { POST as markRead } from "./channels/[channelId]/read/route";
import { POST as typing } from "./channels/[channelId]/typing/route";
import { POST as runCommand } from "./channels/[channelId]/commands/route";
import { PATCH as editMessage, DELETE as deleteMessage } from "./messages/[messageId]/route";
import { POST as react } from "./messages/[messageId]/reactions/route";
import { DELETE as unreact } from "./messages/[messageId]/reactions/[emoji]/route";
import { GET as search } from "./search/route";
import { resolveBacklinks } from "@/lib/mentions/registry.server";
import { runChatBot } from "@/lib/chat/bot-runner";
import { fanOutChatMessage } from "@/lib/chat/notifications";

type Handler = (req: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
const as = (f: unknown) => f as Handler;

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", orgSlug = "", secId = "", openId = "";
let secChan = "", openChan = "", plainChan = "";
let secMsg = "", lapsedMsg = "";
// insider: in the project and the channel. lapsed: in the channel, not the
// project (joined before the project was limited, or left its team). outsider:
// in neither. joiner: in the project, not yet the channel. admin: an org ADMIN
// in neither. watcher: like insider, notified of every message. mover: loses
// and regains the project.
const u = { insider: "", lapsed: "", outsider: "", joiner: "", admin: "", watcher: "", mover: "" };
const memberIds: Partial<Record<keyof typeof u, string>> = {};

const ctxOf = async (k: keyof typeof u): Promise<AuthContext> => (await loadMemberAuthContext(orgId, u[k]))!;

async function call(
  who: keyof typeof u,
  handler: Handler,
  params: Record<string, string>,
  opts: { method?: string; body?: unknown; query?: string } = {},
) {
  h.ctx = await ctxOf(who);
  const req = new NextRequest(`http://localhost/api/v1/orgs/${orgId}/chat${opts.query ?? ""}`, {
    method: opts.method ?? "GET",
    ...(opts.body !== undefined && { body: JSON.stringify(opts.body), headers: { "content-type": "application/json" } }),
  });
  return handler(req, { params: Promise.resolve({ orgId, ...params }) });
}
const statusOf = async (...args: Parameters<typeof call>) => (await call(...args)).status;
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

const listedIds = async (who: keyof typeof u) =>
  ((await json(await call(who, as(listChannels), {}))).channels as { id: string }[]).map((c) => c.id);
const browsedIds = async (who: keyof typeof u) =>
  ((await json(await call(who, as(browse), {}))).channels as { id: string }[]).map((c) => c.id);
const searchHits = async (who: keyof typeof u, q: string) =>
  ((await json(await call(who, as(search), {}, { query: `?q=${q}` }))).hits as { messageId: string }[]).map((x) => x.messageId);

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `pch ${stamp}`, slug: `pch-${stamp}` } });
  orgId = org.id;
  orgSlug = org.slug;
  for (const k of Object.keys(u) as (keyof typeof u)[]) {
    u[k] = (await prisma.user.create({ data: { email: `${k}-${stamp}@pch.test`, displayName: k } })).id;
    memberIds[k] = (await prisma.orgMember.create({ data: { orgId, userId: u[k], role: k === "admin" ? "ADMIN" : "MEMBER", permissions: "0" } })).id;
  }
  secId = (await prisma.project.create({ data: { orgId, name: "Sec", key: `S${stamp}`.toUpperCase().slice(0, 8), teamScopedAccess: true } })).id;
  openId = (await prisma.project.create({ data: { orgId, name: "Open", key: `O${stamp}`.toUpperCase().slice(0, 8) } })).id;
  for (const k of ["insider", "joiner", "watcher", "mover"] as const) {
    await prisma.projectMember.create({ data: { projectId: secId, orgMemberId: memberIds[k]! } });
  }
  // Public channels: the channel's own rules would show each to everyone.
  secChan = (await prisma.chatChannel.create({ data: { orgId, kind: "CHANNEL", name: `sec-${stamp}`, slug: `sec-${stamp}`, projectId: secId, createdById: u.insider } })).id;
  openChan = (await prisma.chatChannel.create({ data: { orgId, kind: "CHANNEL", name: `open-${stamp}`, slug: `open-${stamp}`, projectId: openId, createdById: u.insider } })).id;
  plainChan = (await prisma.chatChannel.create({ data: { orgId, kind: "CHANNEL", name: `plain-${stamp}`, slug: `plain-${stamp}`, createdById: u.insider } })).id;
  await prisma.chatChannelMember.createMany({
    data: [
      { channelId: secChan, userId: u.insider, role: "ADMIN" },
      { channelId: secChan, userId: u.lapsed, role: "ADMIN", notificationPref: "ALL" },
      { channelId: secChan, userId: u.watcher, notificationPref: "ALL" },
      { channelId: secChan, userId: u.mover },
      { channelId: plainChan, userId: u.lapsed },
    ],
  });
  secMsg = (await prisma.chatMessage.create({ data: { channelId: secChan, authorId: u.insider, content: `secret${stamp} plans` } })).id;
  lapsedMsg = (await prisma.chatMessage.create({ data: { channelId: secChan, authorId: u.lapsed, content: `written before ${stamp}` } })).id;
  await prisma.chatMessage.create({ data: { channelId: plainChan, authorId: u.insider, content: `plain${stamp} lunch` } });
});

afterAll(async () => {
  const channelIds = [secChan, openChan, plainChan];
  await prisma.notification.deleteMany({ where: { orgId } });
  await prisma.reference.deleteMany({ where: { orgId } });
  await prisma.chatPinnedMessage.deleteMany({ where: { channelId: { in: channelIds } } });
  await prisma.chatMessageReaction.deleteMany({ where: { message: { channelId: { in: channelIds } } } });
  await prisma.chatMessageMention.deleteMany({ where: { message: { channelId: { in: channelIds } } } });
  await prisma.chatMessage.deleteMany({ where: { channelId: { in: channelIds } } });
  await prisma.chatChannelMember.deleteMany({ where: { channelId: { in: channelIds } } });
  await prisma.chatChannel.deleteMany({ where: { orgId } });
  await prisma.projectMember.deleteMany({ where: { projectId: { in: [secId, openId] } } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(u) } } });
});

describe("a team-scoped project's channel in the lists", () => {
  it("drops out of the channel list of a member who can't see the project, and their other channels stay", async () => {
    const ids = await listedIds("lapsed");
    expect(ids).toContain(plainChan);
    expect(ids).not.toContain(secChan);
  });

  it("stays in the list of a member who can see the project (positive control)", async () => {
    expect(await listedIds("insider")).toContain(secChan);
  });

  it("is not offered in browse to someone outside the project; open channels are", async () => {
    const ids = await browsedIds("outsider");
    expect(ids).toEqual(expect.arrayContaining([openChan, plainChan]));
    expect(ids).not.toContain(secChan);
  });

  it("is offered to a project member, and to an org admin, who sees every project", async () => {
    expect(await browsedIds("joiner")).toContain(secChan);
    expect(await browsedIds("admin")).toContain(secChan);
  });
});

describe("joining a team-scoped project's channel", () => {
  const isMember = async (k: keyof typeof u) =>
    (await prisma.chatChannelMember.count({ where: { channelId: secChan, userId: u[k] } })) === 1;

  it("is refused to someone outside the project, as if it did not exist", async () => {
    expect(await statusOf("outsider", as(join), { channelId: secChan }, { method: "POST" })).toBe(404);
    expect(await isMember("outsider")).toBe(false);
  });

  it("works for a project member and an org admin (positive control)", async () => {
    try {
      for (const k of ["joiner", "admin"] as const) {
        expect(await statusOf(k, as(join), { channelId: secChan }, { method: "POST" }), k).toBe(200);
        expect(await isMember(k), k).toBe(true);
      }
    } finally {
      await prisma.chatChannelMember.deleteMany({ where: { channelId: secChan, userId: { in: [u.joiner, u.admin] } } });
    }
  });

  it("works for anyone on a channel whose project is not team-scoped", async () => {
    try {
      expect(await statusOf("outsider", as(join), { channelId: openChan }, { method: "POST" })).toBe(200);
    } finally {
      await prisma.chatChannelMember.deleteMany({ where: { channelId: openChan, userId: u.outsider } });
    }
  });
});

/** Every read of one channel. */
const READS: [string, Handler, () => Record<string, string>][] = [
  ["read the channel", as(channelDetail), () => ({ channelId: secChan })],
  ["read its messages", as(messages), () => ({ channelId: secChan })],
  ["read a thread", as(replies), () => ({ channelId: secChan, messageId: secMsg })],
  ["read its pins", as(pins), () => ({ channelId: secChan })],
  ["read its read state", as(readState), () => ({ channelId: secChan })],
  ["list its members", as(roster), () => ({ channelId: secChan })],
];

describe("reading a team-scoped project's channel", () => {
  it.each(READS)("a member of the channel who can't see the project may not %s", async (_n, handler, params) => {
    expect(await statusOf("lapsed", handler, params())).toBe(404);
  });

  it.each(READS)("a member who can see the project may %s (positive control)", async (_n, handler, params) => {
    expect(await statusOf("insider", handler, params())).toBe(200);
  });

  it.each(READS)("an org admin outside the project and the channel may %s", async (_n, handler, params) => {
    expect(await statusOf("admin", handler, params())).toBe(200);
  });

  it("shows the messages to who may read them, and no message to who may not", async () => {
    const res = await call("insider", as(messages), { channelId: secChan });
    expect(JSON.stringify(await res.json())).toContain(`secret${stamp}`);
    expect(await (await call("lapsed", as(messages), { channelId: secChan })).text()).not.toContain(`secret${stamp}`);
  });

  it("search finds its messages for a project member, not for a channel member outside the project", async () => {
    expect(await searchHits("insider", `secret${stamp}`)).toContain(secMsg);
    expect(await searchHits("lapsed", `secret${stamp}`)).toEqual([]);
    // Positive control: the same search reaches the lapsed member's other channel.
    expect((await searchHits("lapsed", `plain${stamp}`)).length).toBe(1);
  });

  it("search scoped to that channel finds nothing for them either", async () => {
    const hits = (await json(await call("lapsed", as(search), {}, { query: `?q=secret${stamp}&channelId=${secChan}` }))).hits;
    expect(hits).toEqual([]);
  });
});

describe("writing to a team-scoped project's channel", () => {
  /** Writes a member of the channel who can't see the project tries. */
  const WRITES: [string, () => Parameters<typeof call>][] = [
    ["post a message", () => ["lapsed", as(postMessage), { channelId: secChan }, { method: "POST", body: { id: randomUUID(), content: "still here?" } }]],
    ["show as typing", () => ["lapsed", as(typing), { channelId: secChan }, { method: "POST" }]],
    ["pin a message", () => ["lapsed", as(pin), { channelId: secChan }, { method: "POST", body: { messageId: secMsg } }]],
    ["mark it read", () => ["lapsed", as(markRead), { channelId: secChan }, { method: "POST", body: { messageId: secMsg } }]],
    ["run a command", () => ["lapsed", as(runCommand), { channelId: secChan }, { method: "POST", body: { command: "topic", args: "mine now" } }]],
    ["react to a message", () => ["lapsed", as(react), { messageId: secMsg }, { method: "POST", body: { emoji: "+1" } }]],
    ["remove a reaction", () => ["lapsed", as(unreact), { messageId: secMsg, emoji: "+1" }, { method: "DELETE" }]],
    ["edit their own message", () => ["lapsed", as(editMessage), { messageId: lapsedMsg }, { method: "PATCH", body: { content: "edited" } }]],
    ["delete their own message", () => ["lapsed", as(deleteMessage), { messageId: lapsedMsg }, { method: "DELETE" }]],
  ];

  it.each(WRITES)("a member of the channel who can't see the project may not %s", async (_n, args) => {
    expect(await statusOf(...args())).toBe(404);
  });

  it("leaves the channel as it was after all of them", async () => {
    expect(await prisma.chatMessage.count({ where: { channelId: secChan } })).toBe(2);
    const mine = await prisma.chatMessage.findUniqueOrThrow({ where: { id: lapsedMsg } });
    expect(mine.content).toBe(`written before ${stamp}`);
    expect(mine.deletedAt).toBeNull();
    expect(await prisma.chatPinnedMessage.count({ where: { channelId: secChan } })).toBe(0);
    expect(await prisma.chatMessageReaction.count({ where: { messageId: secMsg } })).toBe(0);
    expect((await prisma.chatChannel.findUniqueOrThrow({ where: { id: secChan } })).topic).toBeNull();
  });

  it("a member who can see the project posts, types, reacts and marks read (positive control)", async () => {
    const id = randomUUID();
    try {
      expect(await statusOf("insider", as(postMessage), { channelId: secChan }, { method: "POST", body: { id, content: "hello team" } })).toBe(201);
      expect(await statusOf("insider", as(typing), { channelId: secChan }, { method: "POST" })).toBe(200);
      expect(await statusOf("insider", as(react), { messageId: secMsg }, { method: "POST", body: { emoji: "+1" } })).toBe(200);
      expect(await statusOf("insider", as(markRead), { channelId: secChan }, { method: "POST", body: { messageId: secMsg } })).toBe(200);
    } finally {
      await prisma.chatMessageReaction.deleteMany({ where: { messageId: secMsg } });
      await prisma.notification.deleteMany({ where: { refId: id } });
      await prisma.chatMessage.deleteMany({ where: { id } });
    }
  });
});

describe("a member who loses the project", () => {
  it("loses the channel at once, and has it back when they can see the project again", async () => {
    const pm = await prisma.projectMember.findFirstOrThrow({ where: { projectId: secId, orgMemberId: memberIds.mover! } });
    expect(await statusOf("mover", as(channelDetail), { channelId: secChan })).toBe(200);
    expect(await listedIds("mover")).toContain(secChan);

    await prisma.projectMember.delete({ where: { id: pm.id } });
    try {
      expect(await statusOf("mover", as(channelDetail), { channelId: secChan })).toBe(404);
      expect(await statusOf("mover", as(messages), { channelId: secChan })).toBe(404);
      expect(await listedIds("mover")).not.toContain(secChan);
      // Still a member: nothing was removed, the project decides.
      expect(await prisma.chatChannelMember.count({ where: { channelId: secChan, userId: u.mover } })).toBe(1);
    } finally {
      await prisma.projectMember.create({ data: { projectId: secId, orgMemberId: memberIds.mover! } });
    }
    expect(await statusOf("mover", as(channelDetail), { channelId: secChan })).toBe(200);
    expect(await listedIds("mover")).toContain(secChan);
  });
});

describe("a message in a team-scoped project's channel", () => {
  it("notifies a member who can see the project, and not one who can't, nor bumps their unread count", async () => {
    const bumps: string[] = [];
    const offs = [u.lapsed, u.watcher].map((userId) =>
      getBus().subscribe([topics.user(userId)], (e) => {
        if (e.type === "chat.unread.bumped") bumps.push(userId);
      }),
    );
    const m = await prisma.chatMessage.create({ data: { channelId: secChan, authorId: u.insider, content: `news${stamp}` } });
    try {
      // The fan-out a post runs (detached there), awaited so every recipient is done.
      await fanOutChatMessage({
        orgId, orgSlug, channelId: secChan, channelKind: "CHANNEL", channelName: `sec-${stamp}`,
        messageId: m.id, authorId: u.insider, authorDisplayName: "insider", content: m.content, mentionedUserIds: [],
      });
      // Both chose ALL. Positive control first: the watcher was notified.
      expect(await prisma.notification.count({ where: { refId: m.id, userId: u.watcher } })).toBe(1);
      expect(bumps).toContain(u.watcher);
      expect(await prisma.notification.count({ where: { refId: m.id, userId: u.lapsed } })).toBe(0);
      expect(bumps).not.toContain(u.lapsed);
    } finally {
      for (const off of offs) off();
      await prisma.notification.deleteMany({ where: { refId: m.id } });
      await prisma.chatMessage.deleteMany({ where: { id: m.id } });
    }
  });

  it("is listed as a mention backlink only to who can see the project", async () => {
    const targetId = randomUUID();
    await prisma.reference.create({ data: { orgId, sourceType: "chatMessage", sourceId: secMsg, targetType: "workItem", targetId } });
    const links = async (k: keyof typeof u) =>
      (await resolveBacklinks({ ctx: await ctxOf(k), orgSlug, targetType: "workItem", targetId })).filter((b) => b.sourceType === "chatMessage");
    try {
      expect(await links("insider")).toHaveLength(1);
      expect(await links("admin")).toHaveLength(1);
      // A member of the (public) channel who has lost the project, and someone outside it.
      expect(await links("lapsed")).toEqual([]);
      expect(await links("outsider")).toEqual([]);
    } finally {
      await prisma.reference.deleteMany({ where: { orgId, targetId } });
    }
  });
});

describe("Cosmo in a team-scoped project's channel", () => {
  it("never reads the channel into the model for someone who can't see the project", async () => {
    const run = async (k: keyof typeof u) => {
      const before = h.agentRuns;
      await runChatBot({ bot: "answerer", orgId, orgSlug, channelId: secChan, invokerUserId: u[k], invokerAuth: await ctxOf(k), prompt: "what are the plans?" });
      return h.agentRuns - before;
    };
    expect(await run("lapsed")).toBe(0);
    expect(await run("outsider")).toBe(0);
    // Positive control: a project member's question reaches the model.
    expect(await run("insider")).toBe(1);
  });
});
