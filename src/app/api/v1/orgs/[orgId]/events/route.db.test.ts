// @vitest-environment node
//
// The org event stream fans out what is published to the org topic. Work-item
// events name a project, so a subscriber may hear one only when they may read
// work items there. Driven through the real route and the in-process bus.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { scopeMask } from "@/lib/auth/api-key";
import { publishToOrg } from "@/lib/realtime/broker";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  return {
    getAuthContext: async () => h.ctx,
    getCurrentUser: async () => null,
    // The real checks: the stream re-reads its session row, and the org's
    // floors against the address it opened from, on each refresh.
    sessionStillValid: actual.sessionStillValid,
  };
});

import { GET } from "./route";
import { AUDIENCE_TTL_MS } from "@/lib/realtime/stream-gate.server";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", openId = "", secId = "", channelId = "";
const users: Record<"insider" | "outsider" | "guest" | "viewer", string> = { insider: "", outsider: "", guest: "", viewer: "" };

type Sse = { type: string; data: Record<string, unknown> };

/** Open the stream as `ctx` (with a session cookie and request headers, if given); returns a reader over its parsed events. */
async function open(ctx: AuthContext, sessionId?: string, headers: Record<string, string> = {}) {
  h.ctx = ctx;
  const res = await GET(
    new NextRequest(`http://localhost/api/v1/orgs/${orgId}/events`, {
      headers: { ...headers, ...(sessionId && { cookie: `session=${sessionId}` }) },
    }),
    { params: Promise.resolve({ orgId }) },
  );
  if (res.status !== 200 || !res.body) {
    return { status: res.status, until: async () => [] as Sse[], ended: async () => true, close: async () => {} };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finished = false;
  const seen: Sse[] = [];
  // One read outstanding at a time, kept across polls: a read abandoned when
  // the poll times out would swallow the next chunk, and with it an event.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  // `performance.now`, not `Date.now`: a test below fakes Date.
  const clock = () => performance.now();
  async function poll() {
    pending ??= reader.read();
    const chunk = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 250))]);
    if (!chunk) return;
    pending = null;
    if (chunk.done) {
      finished = true;
      return;
    }
    buf += decoder.decode(chunk.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const type = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (type && data) seen.push({ type, data: JSON.parse(data) });
    }
  }
  /** Read until `done(seen)` holds, or fail after 5 s. */
  async function until(done: (events: Sse[]) => boolean): Promise<Sse[]> {
    const deadline = clock() + 5_000;
    while (!done(seen)) {
      if (finished || clock() > deadline) throw new Error(`${finished ? "stream ended" : "timed out"}; saw ${seen.map((e) => e.type).join(", ")}`);
      await poll();
    }
    return seen;
  }
  /** Whether the server ends the stream within 5 s. */
  async function ended(): Promise<boolean> {
    const deadline = clock() + 5_000;
    while (!finished && clock() < deadline) await poll();
    return finished;
  }
  return { status: res.status, until, ended, close: () => reader.cancel() };
}

const ctxOf = async (userId: string) => (await loadMemberAuthContext(orgId, userId))!;

/** A live session row: a recompute re-checks it, and a stream without one closes at its first. */
async function sessionFor(userId: string, row: { authMethod?: string; mfaSatisfied?: boolean } = {}) {
  const id = `sse-${stamp}-${Math.random().toString(36).slice(2, 10)}`;
  await prisma.session.create({ data: { id, userId, expiresAt: new Date(Date.now() + 3_600_000), ...row } });
  return id;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `sse ${stamp}`, slug: `sse-${stamp}` } })).id;
  for (const [name, role] of [["insider", "MEMBER"], ["outsider", "MEMBER"], ["guest", "GUEST"], ["viewer", "VIEWER"]] as const) {
    users[name] = (await prisma.user.create({ data: { email: `${name}-${stamp}@sse.test`, displayName: name } })).id;
    await prisma.orgMember.create({ data: { orgId, userId: users[name], role, permissions: "0" } });
  }
  openId = (await prisma.project.create({ data: { orgId, name: "Open", key: `O${stamp}`.toUpperCase().slice(0, 8) } })).id;
  secId = (await prisma.project.create({ data: { orgId, name: "Sec", key: `S${stamp}`.toUpperCase().slice(0, 8), teamScopedAccess: true } })).id;
  const insiderMember = await prisma.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId, userId: users.insider } } });
  await prisma.projectMember.create({ data: { projectId: secId, orgMemberId: insiderMember.id } });
  channelId = (await prisma.chatChannel.create({ data: { orgId, kind: "CHANNEL", name: `c-${stamp}`, createdById: users.insider } })).id;
  for (const u of [users.insider, users.viewer]) await prisma.chatChannelMember.create({ data: { channelId, userId: u } });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: Object.values(users) } } });
  await prisma.ipAllowlist.deleteMany({ where: { orgId } });
  await prisma.orgSecuritySettings.deleteMany({ where: { orgId } });
  await prisma.chatChannelMember.deleteMany({ where: { channelId } });
  await prisma.chatChannel.deleteMany({ where: { orgId } });
  await prisma.projectMember.deleteMany({ where: { projectId: { in: [openId, secId] } } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
});

/** One hidden event, then a visible marker: ordering proves the hidden one was dropped, not late. */
function publishPair(marker: string) {
  publishToOrg(orgId, "work-item.created", { id: `hidden-${marker}`, projectId: secId, ticketNumber: 7 });
  publishToOrg(orgId, "work-item.created", { id: `marker-${marker}`, projectId: openId, ticketNumber: 8 });
}
const ids = (events: Sse[]) => events.filter((e) => e.type.startsWith("work-item.")).map((e) => e.data.id);

describe("the org event stream", () => {
  it("does not send a team-scoped project's events to a member outside it", async () => {
    const s = await open(await ctxOf(users.outsider));
    expect(s.status).toBe(200);
    await s.until((e) => e.some((x) => x.type === "hello"));
    publishPair("a");
    const seen = await s.until((e) => ids(e).includes("marker-a"));
    await s.close();
    expect(ids(seen)).toEqual(["marker-a"]);
  });

  it("sends them to a member of that project (positive control)", async () => {
    const s = await open(await ctxOf(users.insider));
    await s.until((e) => e.some((x) => x.type === "hello"));
    publishPair("b");
    const seen = await s.until((e) => ids(e).includes("marker-b"));
    await s.close();
    expect(ids(seen)).toEqual(["hidden-b", "marker-b"]);
  });

  it("still sends a GUEST the open project's events, which GUEST may read", async () => {
    const s = await open(await ctxOf(users.guest));
    await s.until((e) => e.some((x) => x.type === "hello"));
    publishPair("c");
    const seen = await s.until((e) => ids(e).includes("marker-c"));
    await s.close();
    expect(ids(seen)).toEqual(["marker-c"]);
  });

  it("drops a project-bound event that names no project", async () => {
    const s = await open(await ctxOf(users.insider));
    await s.until((e) => e.some((x) => x.type === "hello"));
    publishToOrg(orgId, "work-item.updated", { ids: ["no-project"] });
    publishToOrg(orgId, "work-item.updated", { id: "marker-d", projectId: openId });
    const seen = await s.until((e) => ids(e).includes("marker-d"));
    await s.close();
    expect(ids(seen)).toEqual(["marker-d"]);
  });

  it("joins no chat channel for someone without CHAT_USE, and does for someone with it", async () => {
    const viewer = await open(await ctxOf(users.viewer));
    const hello = (await viewer.until((e) => e.some((x) => x.type === "hello"))).find((x) => x.type === "hello")!;
    expect(hello.data.channels).toEqual([]);
    void getBus().publish(topics.channel(channelId), "chat.message.created", { id: "msg-1", channelId, content: "hi" });
    publishToOrg(orgId, "work-item.created", { id: "marker-e", projectId: openId });
    const seen = await viewer.until((e) => ids(e).includes("marker-e"));
    await viewer.close();
    expect(seen.some((x) => x.type === "chat.message.created")).toBe(false);

    const insider = await open(await ctxOf(users.insider));
    const insiderHello = (await insider.until((e) => e.some((x) => x.type === "hello"))).find((x) => x.type === "hello")!;
    expect(insiderHello.data.channels).toEqual([channelId]);
    void getBus().publish(topics.channel(channelId), "chat.message.created", { id: "msg-2", channelId, content: "hi" });
    const got = await insider.until((e) => e.some((x) => x.type === "chat.message.created"));
    await insider.close();
    expect(got.find((x) => x.type === "chat.message.created")?.data.id).toBe("msg-2");
  });

  it("sends a plugin's events to a member, and not to a GUEST, who may not read what they announce", async () => {
    const guest = await open(await ctxOf(users.guest));
    const member = await open(await ctxOf(users.outsider));
    await guest.until((e) => e.some((x) => x.type === "hello"));
    await member.until((e) => e.some((x) => x.type === "hello"));
    publishToOrg(orgId, "pi_planning.board.changed", { eventId: "pi-1" });
    publishToOrg(orgId, "work-item.created", { id: "marker-i", projectId: openId });
    const g = await guest.until((e) => ids(e).includes("marker-i"));
    const m = await member.until((e) => ids(e).includes("marker-i"));
    await guest.close();
    await member.close();
    expect(g.some((x) => x.type === "pi_planning.board.changed")).toBe(false);
    expect(m.find((x) => x.type === "pi_planning.board.changed")?.data.eventId).toBe("pi-1");
  });

  it("stops sending a private channel's messages to someone removed from it, and not to who remains", async () => {
    await prisma.chatChannelMember.create({ data: { channelId, userId: users.outsider } });
    // Signed in: leaving recomputes at once, which re-checks the session.
    const removed = await open(await ctxOf(users.outsider), await sessionFor(users.outsider));
    const stays = await open(await ctxOf(users.insider), await sessionFor(users.insider));
    const chatIds = (events: Sse[]) => events.filter((x) => x.type === "chat.message.created").map((x) => x.data.id);
    try {
      await removed.until((e) => e.some((x) => x.type === "hello"));
      await stays.until((e) => e.some((x) => x.type === "hello"));
      await getBus().publish(topics.channel(channelId), "chat.message.created", { id: "before", channelId, content: "x" });
      await removed.until((e) => chatIds(e).includes("before"));

      await prisma.chatChannelMember.deleteMany({ where: { channelId, userId: users.outsider } });
      await getBus().publish(topics.user(users.outsider), "chat.channel.left", { channelId });
      await getBus().publish(topics.channel(channelId), "chat.message.created", { id: "after", channelId, content: "y" });
      publishToOrg(orgId, "work-item.created", { id: "marker-h", projectId: openId });

      const gone = await removed.until((e) => ids(e).includes("marker-h"));
      expect(chatIds(gone)).toEqual(["before"]);
      expect(gone.some((x) => x.type === "chat.channel.left")).toBe(true);
      const kept = await stays.until((e) => ids(e).includes("marker-h"));
      expect(chatIds(kept)).toEqual(["before", "after"]);
    } finally {
      await removed.close();
      await stays.close();
      await prisma.chatChannelMember.deleteMany({ where: { channelId, userId: users.outsider } });
    }
  });

  it("refuses an API key, whatever its scopes", async () => {
    const member = await ctxOf(users.insider);
    for (const scopes of [["read"], ["rules:run"], ["read", "items:write"]]) {
      const s = await open({ ...member, isApiKey: true, scopes, permissions: member.permissions & scopeMask(scopes) });
      expect(s.status, scopes.join(",")).toBe(403);
    }
    // The same person's browser session still connects.
    const session = await open(member);
    expect(session.status).toBe(200);
    await session.close();
  });
});

describe("a stream and the session it opened with", () => {
  const hello = (e: Sse[]) => e.some((x) => x.type === "hello");
  /** Past the audience TTL, so the next 25 s heartbeat refreshes. */
  const PAST_REFRESH = AUDIENCE_TTL_MS + 25_000;

  const sessionRow = (row: { authMethod?: string; mfaSatisfied?: boolean } = {}) => sessionFor(users.insider, row);

  // Fake only the heartbeat interval and the clock the gate reads; timeouts
  // and database I/O stay real.
  const fakeClock = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });

  it("keeps delivering across refreshes while the session lives (positive control)", async () => {
    const sid = await sessionRow();
    fakeClock();
    try {
      const s = await open(await ctxOf(users.insider), sid);
      await s.until(hello);
      await vi.advanceTimersByTimeAsync(PAST_REFRESH);
      expect(await s.ended()).toBe(false);
      publishToOrg(orgId, "work-item.created", { id: "marker-f", projectId: openId });
      expect(ids(await s.until((e) => ids(e).includes("marker-f")))).toContain("marker-f");
      await s.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends at the next refresh once the session is signed out", async () => {
    const sid = await sessionRow();
    fakeClock();
    try {
      const s = await open(await ctxOf(users.insider), sid);
      await s.until(hello);
      await prisma.session.delete({ where: { id: sid } });
      await vi.advanceTimersByTimeAsync(PAST_REFRESH);
      expect(await s.ended()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends at the next refresh once the org requires MFA the session never completed", async () => {
    const sid = await sessionRow({ authMethod: "password", mfaSatisfied: false });
    fakeClock();
    try {
      const s = await open(await ctxOf(users.insider), sid);
      await s.until(hello);
      await vi.advanceTimersByTimeAsync(PAST_REFRESH);
      expect(await s.ended()).toBe(false);
      await prisma.orgSecuritySettings.upsert({ where: { orgId }, create: { orgId, mfaRequired: true }, update: { mfaRequired: true } });
      await vi.advanceTimersByTimeAsync(PAST_REFRESH);
      expect(await s.ended()).toBe(true);
    } finally {
      vi.useRealTimers();
      await prisma.orgSecuritySettings.deleteMany({ where: { orgId } });
    }
  });

  it("ends at the next refresh once the IP allowlist stops admitting the address it opened from", async () => {
    await prisma.orgSecuritySettings.upsert({ where: { orgId }, create: { orgId, ipAllowlistEnabled: true }, update: { ipAllowlistEnabled: true } });
    const rule = await prisma.ipAllowlist.create({ data: { orgId, cidr: "203.0.113.0/24" } });
    const sid = await sessionRow();
    fakeClock();
    try {
      // One X-Forwarded-For entry: the client's address under either reading of the header.
      const s = await open(await ctxOf(users.insider), sid, { "x-forwarded-for": "203.0.113.9" });
      await s.until(hello);
      await vi.advanceTimersByTimeAsync(PAST_REFRESH);
      expect(await s.ended()).toBe(false);
      await prisma.ipAllowlist.update({ where: { id: rule.id }, data: { cidr: "198.51.100.0/24" } });
      await vi.advanceTimersByTimeAsync(PAST_REFRESH);
      expect(await s.ended()).toBe(true);
    } finally {
      vi.useRealTimers();
      await prisma.ipAllowlist.deleteMany({ where: { orgId } });
      await prisma.orgSecuritySettings.deleteMany({ where: { orgId } });
    }
  });

  it("judges the address the edge wrote, never one the client put first in X-Forwarded-For", async () => {
    // The edge appends the address it accepted the connection from (198.51.100.7);
    // the client wrote 203.0.113.9 ahead of it.
    await prisma.orgSecuritySettings.upsert({ where: { orgId }, create: { orgId, ipAllowlistEnabled: true }, update: { ipAllowlistEnabled: true } });
    const rule = await prisma.ipAllowlist.create({ data: { orgId, cidr: "198.51.100.0/24" } });
    const sid = await sessionRow();
    fakeClock();
    try {
      const s = await open(await ctxOf(users.insider), sid, { "x-forwarded-for": "203.0.113.9, 198.51.100.7" });
      await s.until(hello);
      // The edge's address is in the list: the stream stays open.
      await vi.advanceTimersByTimeAsync(PAST_REFRESH);
      expect(await s.ended()).toBe(false);
      // Only the client-written address is in the list: the stream ends.
      await prisma.ipAllowlist.update({ where: { id: rule.id }, data: { cidr: "203.0.113.0/24" } });
      await vi.advanceTimersByTimeAsync(PAST_REFRESH);
      expect(await s.ended()).toBe(true);
    } finally {
      vi.useRealTimers();
      await prisma.ipAllowlist.deleteMany({ where: { orgId } });
      await prisma.orgSecuritySettings.deleteMany({ where: { orgId } });
    }
  });
});
