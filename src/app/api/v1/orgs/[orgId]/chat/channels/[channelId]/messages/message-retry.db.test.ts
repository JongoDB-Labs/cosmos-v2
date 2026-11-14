// @vitest-environment node
//
// Sending a message carries a client-generated id, so a retry of the same send
// returns the message already saved instead of posting it twice. The duplicate-
// message check matches the channel and author too: only the same id, in the
// same channel, by the same author, is a retry. Any other id already in use is
// a conflict, answered without the message.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/db/client";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { POST } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
const ids = { org: "", otherOrg: "", poster: "", other: "", outside: "", chanA: "", chanB: "", chanX: "" };
const msg = { otherInB: "", posterInB: "", otherInA: "", inOtherOrg: "" };
const text = (k: keyof typeof msg) => `${k}-${stamp}`;

async function send(id: string, content = `hello ${stamp}`) {
  h.ctx = await loadMemberAuthContext(ids.org, ids.poster);
  const req = new NextRequest(`http://localhost/api/v1/orgs/${ids.org}/chat/channels/${ids.chanA}/messages`, {
    method: "POST",
    body: JSON.stringify({ id, content }),
    headers: { "content-type": "application/json" },
  });
  return POST(req, { params: Promise.resolve({ orgId: ids.org, channelId: ids.chanA }) });
}

beforeAll(async () => {
  ids.org = (await prisma.organization.create({ data: { name: `retry ${stamp}`, slug: `retry-${stamp}` } })).id;
  ids.otherOrg = (await prisma.organization.create({ data: { name: `retry2 ${stamp}`, slug: `retry2-${stamp}` } })).id;
  for (const k of ["poster", "other", "outside"] as const) {
    ids[k] = (await prisma.user.create({ data: { email: `${k}-${stamp}@retry.test`, displayName: k } })).id;
  }
  await prisma.orgMember.createMany({
    data: [
      { orgId: ids.org, userId: ids.poster, role: "MEMBER", permissions: "0" },
      { orgId: ids.org, userId: ids.other, role: "MEMBER", permissions: "0" },
      { orgId: ids.otherOrg, userId: ids.outside, role: "MEMBER", permissions: "0" },
    ],
  });
  const channel = (orgId: string, name: string, by: string) =>
    prisma.chatChannel.create({ data: { orgId, kind: "CHANNEL", name, slug: name, createdById: by } });
  ids.chanA = (await channel(ids.org, `a-${stamp}`, ids.poster)).id;
  ids.chanB = (await channel(ids.org, `b-${stamp}`, ids.poster)).id;
  ids.chanX = (await channel(ids.otherOrg, `x-${stamp}`, ids.outside)).id;
  await prisma.chatChannelMember.createMany({
    data: [
      { channelId: ids.chanA, userId: ids.poster },
      { channelId: ids.chanA, userId: ids.other },
      { channelId: ids.chanB, userId: ids.poster },
      { channelId: ids.chanB, userId: ids.other },
      { channelId: ids.chanX, userId: ids.outside },
    ],
  });
  const put = async (k: keyof typeof msg, channelId: string, authorId: string) => {
    msg[k] = (await prisma.chatMessage.create({ data: { channelId, authorId, content: text(k) } })).id;
  };
  await put("otherInB", ids.chanB, ids.other);
  await put("posterInB", ids.chanB, ids.poster);
  await put("otherInA", ids.chanA, ids.other);
  await put("inOtherOrg", ids.chanX, ids.outside);
});

afterAll(async () => {
  const channelIds = [ids.chanA, ids.chanB, ids.chanX];
  await prisma.notification.deleteMany({ where: { orgId: { in: [ids.org, ids.otherOrg] } } });
  await prisma.chatMessageMention.deleteMany({ where: { message: { channelId: { in: channelIds } } } });
  await prisma.chatMessage.deleteMany({ where: { channelId: { in: channelIds } } });
  await prisma.chatChannelMember.deleteMany({ where: { channelId: { in: channelIds } } });
  await prisma.chatChannel.deleteMany({ where: { id: { in: channelIds } } });
  await prisma.orgMember.deleteMany({ where: { orgId: { in: [ids.org, ids.otherOrg] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.poster, ids.other, ids.outside] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ids.org, ids.otherOrg] } } });
});

describe("sending a message with a client id already in use", () => {
  it("returns the saved message on a retry in the same channel by the same author, and saves it once", async () => {
    const id = randomUUID();
    const first = await send(id, `retry ${stamp}`);
    expect(first.status).toBe(201);
    const again = await send(id, `retry ${stamp}`);
    expect(again.status).toBe(201);
    const body = (await again.json()) as { id: string; channelId: string; authorId: string; content: string };
    expect(body).toMatchObject({ id, channelId: ids.chanA, authorId: ids.poster, content: `retry ${stamp}` });
    expect(await prisma.chatMessage.count({ where: { id } })).toBe(1);
  });

  it.each([
    ["someone else's message in another channel", "otherInB"],
    ["the same author's message in another channel", "posterInB"],
    ["someone else's message in this channel", "otherInA"],
    ["a message in another organization", "inOtherOrg"],
  ] as const)("is a conflict for the id of %s, answered without that message", async (_label, k) => {
    const before = await prisma.chatMessage.findUniqueOrThrow({ where: { id: msg[k] } });
    const inA = await prisma.chatMessage.count({ where: { channelId: ids.chanA } });

    const res = await send(msg[k]);
    expect(res.status).toBe(409);
    const raw = await res.text();
    expect(raw).not.toContain(text(k));
    expect(raw).not.toContain(before.channelId);
    expect(raw).not.toContain(before.authorId);

    // Nothing was saved, and the message the id belongs to is as it was.
    expect(await prisma.chatMessage.count({ where: { channelId: ids.chanA } })).toBe(inA);
    expect(await prisma.chatMessage.findUniqueOrThrow({ where: { id: msg[k] } })).toEqual(before);
  });
});
