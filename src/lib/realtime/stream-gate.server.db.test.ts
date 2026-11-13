// @vitest-environment node
//
// A stream connection stays open for hours; who may read which project changes
// under it. These pin how the gate keeps up: on a timer, at once when the
// member's own access changes, for a project created after connecting, and by
// closing when the member is removed or the session it opened with ends.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { sessionStillValid } from "@/lib/auth/session";
import { AUDIENCE_TTL_MS, openStreamGate } from "./stream-gate.server";
import { topics } from "./topics";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", userId = "", memberId = "", secId = "", channelId = "";

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `gate ${stamp}`, slug: `gate-${stamp}` } })).id;
  userId = (await prisma.user.create({ data: { email: `g-${stamp}@gate.test`, displayName: "Gate" } })).id;
  memberId = (await prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER", permissions: "0" } })).id;
  secId = (await prisma.project.create({ data: { orgId, name: "Sec", key: `S${stamp}`.toUpperCase().slice(0, 8), teamScopedAccess: true } })).id;
  channelId = (await prisma.chatChannel.create({ data: { orgId, kind: "CHANNEL", name: `c-${stamp}`, createdById: userId } })).id;
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.ipAllowlist.deleteMany({ where: { orgId } });
  await prisma.chatChannelMember.deleteMany({ where: { channelId } });
  await prisma.chatChannel.deleteMany({ where: { orgId } });
  await prisma.orgSecuritySettings.deleteMany({ where: { orgId } });
  await prisma.projectMember.deleteMany({ where: { project: { orgId } } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

const onOrg = (type: string, data: unknown) => ({ topic: topics.org(orgId), type, data });
const created = (projectId: string) => onOrg("work-item.created", { id: "x", projectId });

describe("the stream gate keeps its audience current", () => {
  it("picks up a new project membership only after the audience goes stale", async () => {
    let t = 1_000_000;
    const gate = await openStreamGate((await loadMemberAuthContext(orgId, userId))!, { now: () => t });
    expect(await gate.admit(created(secId))).toBe(false);

    const pm = await prisma.projectMember.create({ data: { projectId: secId, orgMemberId: memberId } });
    try {
      t += AUDIENCE_TTL_MS - 1;
      expect(await gate.admit(created(secId))).toBe(false);
      t += 1;
      expect(await gate.admit(created(secId))).toBe(true);

      // And loses it the same way.
      await prisma.projectMember.delete({ where: { id: pm.id } });
      t += AUDIENCE_TTL_MS;
      expect(await gate.admit(created(secId))).toBe(false);
    } finally {
      await prisma.projectMember.deleteMany({ where: { id: pm.id } });
    }
  });

  it("recomputes at once when an event says this member's own access changed", async () => {
    const t = 2_000_000;
    const gate = await openStreamGate((await loadMemberAuthContext(orgId, userId))!, { now: () => t });
    const chat = onOrg("chat.presence.changed", { userId: "someone" });
    expect(await gate.admit(chat)).toBe(true);

    await prisma.orgMember.update({ where: { id: memberId }, data: { role: "VIEWER" } });
    try {
      // Someone else's change does not trigger a recompute.
      await gate.admit(onOrg("member.updated", { memberId: "someone-else" }));
      expect(await gate.admit(chat)).toBe(true);
      // Their own does: a VIEWER holds no CHAT_USE.
      await gate.admit(onOrg("member.updated", { memberId, role: "VIEWER" }));
      expect(await gate.admit(chat)).toBe(false);
    } finally {
      await prisma.orgMember.update({ where: { id: memberId }, data: { role: "MEMBER" } });
    }
  });

  it("hears a project created after it connected", async () => {
    const t = 3_000_000;
    const gate = await openStreamGate((await loadMemberAuthContext(orgId, userId))!, { now: () => t });
    const fresh = await prisma.project.create({ data: { orgId, name: "New", key: `N${stamp}`.toUpperCase().slice(0, 8) } });
    expect(await gate.admit(created(fresh.id))).toBe(true);
    // An id that is not a project in this org stays dropped after the recompute.
    expect(await gate.admit(created("00000000-0000-0000-0000-000000000000"))).toBe(false);
  });

  it("closes when the member is removed from the org", async () => {
    let t = 4_000_000;
    const gate = await openStreamGate((await loadMemberAuthContext(orgId, userId))!, { now: () => t });
    const ok = onOrg("settings.updated", { orgId, section: "org" });
    expect(await gate.admit(ok)).toBe(true);
    expect(gate.closed).toBe(false);

    await prismaUnfiltered.orgMember.update({ where: { id: memberId }, data: { removedAt: new Date() } });
    try {
      t += AUDIENCE_TTL_MS;
      expect(await gate.admit(ok)).toBe(false);
      expect(gate.closed).toBe(true);
    } finally {
      await prismaUnfiltered.orgMember.update({ where: { id: memberId }, data: { removedAt: null } });
    }
  });
});

describe("the stream gate and chat channel membership", () => {
  const message = () => ({ topic: topics.channel(channelId), type: "chat.message.created", data: { id: "m", channelId, content: "private" } });
  const reaction = () => ({ topic: topics.channel(channelId), type: "chat.reaction.added", data: { messageId: "m", emoji: "+1" } });
  const left = () => ({ topic: topics.user(userId), type: "chat.channel.left", data: { channelId } });

  it("drops a channel's traffic at once when the member's own leave event arrives", async () => {
    const t = 10_000_000;
    const row = await prisma.chatChannelMember.create({ data: { channelId, userId } });
    try {
      const gate = await openStreamGate((await loadMemberAuthContext(orgId, userId))!, { now: () => t });
      expect(await gate.admit(message())).toBe(true);
      expect(await gate.admit(reaction())).toBe(true);

      await prisma.chatChannelMember.delete({ where: { id: row.id } });
      // Still told that they left; the clock has not moved.
      expect(await gate.admit(left())).toBe(true);
      expect(await gate.admit(message())).toBe(false);
      expect(await gate.admit(reaction())).toBe(false);
    } finally {
      await prisma.chatChannelMember.deleteMany({ where: { channelId, userId } });
    }
  });

  it("drops it at the next refresh when no leave event comes, and not before", async () => {
    let t = 11_000_000;
    const row = await prisma.chatChannelMember.create({ data: { channelId, userId } });
    try {
      const gate = await openStreamGate((await loadMemberAuthContext(orgId, userId))!, { now: () => t });
      await prisma.chatChannelMember.delete({ where: { id: row.id } });
      t += AUDIENCE_TTL_MS - 1;
      expect(await gate.admit(message())).toBe(true);
      t += 1;
      expect(await gate.admit(message())).toBe(false);
    } finally {
      await prisma.chatChannelMember.deleteMany({ where: { channelId, userId } });
    }
  });

  it("does not drop a channel the member is still in when someone else leaves it (positive control)", async () => {
    const t = 12_000_000;
    await prisma.chatChannelMember.create({ data: { channelId, userId } });
    try {
      const gate = await openStreamGate((await loadMemberAuthContext(orgId, userId))!, { now: () => t });
      expect(await gate.admit(left())).toBe(true);
      expect(await gate.admit(message())).toBe(true);
    } finally {
      await prisma.chatChannelMember.deleteMany({ where: { channelId, userId } });
    }
  });
});

describe("the stream gate ends with the session it opened with", () => {
  const ok = () => onOrg("settings.updated", { orgId, section: "org" });
  const MIN = 60_000;

  /** A session row for the member, and a gate that re-checks it on every recompute. */
  async function sessionGate(
    t: { now: number },
    row: { expiresAt?: Date; lastActivityAt?: Date; authMethod?: string; mfaSatisfied?: boolean } = {},
    clientIp: string | null = "203.0.113.7",
  ) {
    const id = `gate-${stamp}-${Math.random().toString(36).slice(2, 10)}`;
    await prisma.session.create({
      data: {
        id,
        userId,
        expiresAt: row.expiresAt ?? new Date(Date.now() + 60 * MIN),
        lastActivityAt: row.lastActivityAt,
        authMethod: row.authMethod,
        mfaSatisfied: row.mfaSatisfied ?? false,
      },
    });
    const gate = await openStreamGate((await loadMemberAuthContext(orgId, userId))!, {
      now: () => t.now,
      stillValid: () => sessionStillValid(id, orgId, clientIp),
    });
    return { id, gate };
  }

  it("stays open while the session lives (positive control)", async () => {
    const t = { now: 5_000_000 };
    const { gate } = await sessionGate(t);
    t.now += AUDIENCE_TTL_MS;
    expect(await gate.admit(ok())).toBe(true);
    expect(gate.closed).toBe(false);
  });

  it("closes at the next refresh once the session is signed out or revoked", async () => {
    const t = { now: 6_000_000 };
    const { id, gate } = await sessionGate(t);
    expect(await gate.admit(ok())).toBe(true);

    await prisma.session.delete({ where: { id } });
    // Not before the refresh: the check runs with the recompute, not per event.
    t.now += AUDIENCE_TTL_MS - 1;
    expect(await gate.admit(ok())).toBe(true);
    t.now += 1;
    await gate.refreshIfStale();
    expect(gate.closed).toBe(true);
    expect(await gate.admit(ok())).toBe(false);
  });

  it("closes once the session has expired", async () => {
    const t = { now: 7_000_000 };
    const { id, gate } = await sessionGate(t);
    await prisma.session.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    t.now += AUDIENCE_TTL_MS;
    await gate.refreshIfStale();
    expect(gate.closed).toBe(true);
  });

  it("closes once the session has been idle past the org's timeout, and not before", async () => {
    await prisma.orgSecuritySettings.upsert({ where: { orgId }, create: { orgId, sessionTimeoutMins: 30 }, update: { sessionTimeoutMins: 30 } });
    try {
      const t = { now: 8_000_000 };
      const { id, gate } = await sessionGate(t, { lastActivityAt: new Date(Date.now() - 20 * MIN) });
      t.now += AUDIENCE_TTL_MS;
      await gate.refreshIfStale();
      expect(gate.closed).toBe(false);

      await prisma.session.update({ where: { id }, data: { lastActivityAt: new Date(Date.now() - 31 * MIN) } });
      t.now += AUDIENCE_TTL_MS;
      await gate.refreshIfStale();
      expect(gate.closed).toBe(true);
    } finally {
      await prisma.orgSecuritySettings.deleteMany({ where: { orgId } });
    }
  });

  it("never slides the idle window itself: holding a stream open is not activity", async () => {
    await prisma.orgSecuritySettings.upsert({ where: { orgId }, create: { orgId, sessionTimeoutMins: 30 }, update: { sessionTimeoutMins: 30 } });
    try {
      const t = { now: 9_000_000 };
      const before = new Date(Date.now() - 20 * MIN);
      const { id, gate } = await sessionGate(t, { lastActivityAt: before });
      t.now += AUDIENCE_TTL_MS;
      await gate.refreshIfStale();
      expect((await prisma.session.findUniqueOrThrow({ where: { id } })).lastActivityAt.getTime()).toBe(before.getTime());
    } finally {
      await prisma.orgSecuritySettings.deleteMany({ where: { orgId } });
    }
  });

  it("closes once the org requires MFA and the session never completed it", async () => {
    try {
      const t = { now: 13_000_000 };
      const { gate } = await sessionGate(t, { authMethod: "password", mfaSatisfied: false });
      t.now += AUDIENCE_TTL_MS;
      await gate.refreshIfStale();
      expect(gate.closed).toBe(false);

      await prisma.orgSecuritySettings.upsert({ where: { orgId }, create: { orgId, mfaRequired: true }, update: { mfaRequired: true } });
      t.now += AUDIENCE_TTL_MS;
      await gate.refreshIfStale();
      expect(gate.closed).toBe(true);
    } finally {
      await prisma.orgSecuritySettings.deleteMany({ where: { orgId } });
    }
  });

  it("stays open under required MFA for a session that completed it (positive control)", async () => {
    await prisma.orgSecuritySettings.upsert({ where: { orgId }, create: { orgId, mfaRequired: true }, update: { mfaRequired: true } });
    try {
      const t = { now: 14_000_000 };
      const { gate } = await sessionGate(t, { authMethod: "password", mfaSatisfied: true });
      t.now += AUDIENCE_TTL_MS;
      await gate.refreshIfStale();
      expect(gate.closed).toBe(false);
    } finally {
      await prisma.orgSecuritySettings.deleteMany({ where: { orgId } });
    }
  });

  it("closes once the IP allowlist no longer admits the address the stream opened from", async () => {
    await prisma.orgSecuritySettings.upsert({ where: { orgId }, create: { orgId, ipAllowlistEnabled: true }, update: { ipAllowlistEnabled: true } });
    const rule = await prisma.ipAllowlist.create({ data: { orgId, cidr: "203.0.113.0/24" } });
    try {
      const t = { now: 15_000_000 };
      const { gate } = await sessionGate(t, {}, "203.0.113.7");
      t.now += AUDIENCE_TTL_MS;
      await gate.refreshIfStale();
      expect(gate.closed).toBe(false);

      await prisma.ipAllowlist.update({ where: { id: rule.id }, data: { cidr: "198.51.100.0/24" } });
      t.now += AUDIENCE_TTL_MS;
      await gate.refreshIfStale();
      expect(gate.closed).toBe(true);
    } finally {
      await prisma.ipAllowlist.deleteMany({ where: { orgId } });
      await prisma.orgSecuritySettings.deleteMany({ where: { orgId } });
    }
  });
});
