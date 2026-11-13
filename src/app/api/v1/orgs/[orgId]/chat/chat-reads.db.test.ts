// @vitest-environment node
//
// Chat reads checked only that the caller was signed in. A VIEWER or GUEST,
// whose role never opens the Chat page, and any API key (no scope grants
// CHAT_USE) could list channels, read a public channel's messages and search
// every message they could see. An org admin's key could list a private
// channel's members. Reads now need CHAT_USE, like chat writes.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET as listChannels } from "./channels/route";
import { GET as browse } from "./channels/browse/route";
import { GET as channel } from "./channels/[channelId]/route";
import { GET as messages } from "./channels/[channelId]/messages/route";
import { GET as replies } from "./channels/[channelId]/messages/[messageId]/replies/route";
import { GET as pins } from "./channels/[channelId]/pins/route";
import { GET as readState } from "./channels/[channelId]/read-state/route";
import { GET as roster } from "./channels/[channelId]/members/route";
import { GET as search } from "./search/route";
import { GET as presence } from "./presence/route";
import { GET as bots } from "./bots/route";

type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | "GUEST";
type Handler = (req: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", publicId = "", privateId = "", messageId = "";
const u = { member: "", viewer: "", guest: "", admin: "" };

function session(userId: string, role: Role): AuthContext {
  const permissions = RolePermissions[role];
  return { userId, orgId, orgRole: role, abacRules: [], basePermissions: permissions, permissions };
}
function key(userId: string, role: Role, scopes: string[]): AuthContext {
  const s = session(userId, role);
  return { ...s, isApiKey: true, scopes, permissions: s.permissions & scopeMask(scopes), basePermissions: s.basePermissions & scopeMask(scopes) };
}

/** Every chat read, against the public channel (the roster against the private one). */
const READS: [string, Handler, () => Record<string, string>, string?][] = [
  ["list my channels", listChannels as unknown as Handler, () => ({})],
  ["browse channels", browse as unknown as Handler, () => ({})],
  ["read a channel", channel as unknown as Handler, () => ({ channelId: publicId })],
  ["read its messages", messages as unknown as Handler, () => ({ channelId: publicId })],
  ["read a thread", replies as unknown as Handler, () => ({ channelId: publicId, messageId })],
  ["read its pins", pins as unknown as Handler, () => ({ channelId: publicId })],
  ["read its read state", readState as unknown as Handler, () => ({ channelId: publicId })],
  ["search messages", search as unknown as Handler, () => ({}), `?q=marker${stamp}`],
  ["see who is online", presence as unknown as Handler, () => ({})],
  ["list the bots", bots as unknown as Handler, () => ({})],
];

const call = async (ctx: AuthContext, handler: Handler, params: Record<string, string>, query = "") => {
  h.ctx = ctx;
  return handler(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/chat${query}`), { params: Promise.resolve({ orgId, ...params }) });
};

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `chr ${stamp}`, slug: `chr-${stamp}` } })).id;
  const roles: Record<keyof typeof u, Role> = { member: "MEMBER", viewer: "VIEWER", guest: "GUEST", admin: "ADMIN" };
  for (const k of Object.keys(u) as (keyof typeof u)[]) {
    u[k] = (await prisma.user.create({ data: { email: `${k}-${stamp}@chr.test`, displayName: k } })).id;
    await prisma.orgMember.create({ data: { orgId, userId: u[k], role: roles[k], permissions: "0" } });
  }
  publicId = (await prisma.chatChannel.create({ data: { orgId, kind: "CHANNEL", name: "open", slug: `open-${stamp}`, createdById: u.member } })).id;
  privateId = (await prisma.chatChannel.create({ data: { orgId, kind: "CHANNEL", name: "closed", slug: `closed-${stamp}`, isPrivate: true, createdById: u.member } })).id;
  for (const channelId of [publicId, privateId]) {
    await prisma.chatChannelMember.create({ data: { channelId, userId: u.member, role: "ADMIN" } });
  }
  messageId = (await prisma.chatMessage.create({ data: { channelId: publicId, authorId: u.member, content: `marker${stamp} hello` } })).id;
});

afterAll(async () => {
  await prisma.chatMessage.deleteMany({ where: { channelId: { in: [publicId, privateId] } } });
  await prisma.chatChannelMember.deleteMany({ where: { channelId: { in: [publicId, privateId] } } });
  await prisma.chatChannel.deleteMany({ where: { orgId } });
  await prisma.chatBot.deleteMany({ where: { orgId } }).catch(() => {});
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(u) } } });
});

describe("chat reads need CHAT_USE", () => {
  it.each(READS)("a MEMBER's session may %s", async (_n, handler, params, query) => {
    // Positive control: the reads work, so the refusals below are the gate's.
    expect((await call(session(u.member, "MEMBER"), handler, params(), query)).status).toBe(200);
  });

  it("a MEMBER's search finds the message", async () => {
    const res = await call(session(u.member, "MEMBER"), search as unknown as Handler, {}, `?q=marker${stamp}`);
    expect(await res.text()).toContain(`marker${stamp}`);
  });

  it.each(READS)("a VIEWER's session may not %s", async (_n, handler, params, query) => {
    expect((await call(session(u.viewer, "VIEWER"), handler, params(), query)).status).toBe(403);
  });

  it.each(READS)("a GUEST's session may not %s", async (_n, handler, params, query) => {
    expect((await call(session(u.guest, "GUEST"), handler, params(), query)).status).toBe(403);
  });

  it.each(READS)("a MEMBER's read key may not %s", async (_n, handler, params, query) => {
    expect((await call(key(u.member, "MEMBER", ["read", "members:read"]), handler, params(), query)).status).toBe(403);
  });
});

describe("a private channel's members", () => {
  const rosterOf = (ctx: AuthContext) => call(ctx, roster as unknown as Handler, { channelId: privateId });

  it("are listed to an org admin's session, and to a member", async () => {
    expect((await rosterOf(session(u.admin, "ADMIN"))).status).toBe(200);
    expect((await rosterOf(session(u.member, "MEMBER"))).status).toBe(200);
  });

  it("are not listed to a key an org admin minted", async () => {
    expect((await rosterOf(key(u.admin, "ADMIN", ["read", "members:read"]))).status).toBe(403);
  });
});
