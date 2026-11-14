// @vitest-environment node
//
// Chat search's `from:` and `in:` operators match a name with ILIKE, and the
// value went into the pattern as typed: `from:%` matched every author and
// `in:_` every channel. The value is now text, `%` and `_` included, by the
// same rule as the Prisma searches (escapeLike).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET as search } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", searcher = "";
const authors = { percent: "", underscore: "", plain: "" };
const channels = { percent: "", underscore: "", plain: "" };
/** One message per author, each in its own channel: [author, channel, content]. */
const messageIds = { percent: "", underscore: "", plain: "" };

function session(): AuthContext {
  const permissions = RolePermissions.MEMBER;
  return { userId: searcher, orgId, orgRole: "MEMBER", abacRules: [], basePermissions: permissions, permissions };
}

/** The ids of the messages a search for `q` returns. */
async function find(q: string): Promise<string[]> {
  h.ctx = session();
  const res = await search(
    new NextRequest(`http://localhost/api/v1/orgs/${orgId}/chat/search?q=${encodeURIComponent(q)}`),
    { params: Promise.resolve({ orgId }) },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { hits: { messageId: string }[] };
  return body.hits.map((m) => m.messageId).sort();
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `chs ${stamp}`, slug: `chs-${stamp}` } })).id;
  searcher = (await prisma.user.create({ data: { email: `searcher-${stamp}@chs.test`, displayName: "Searcher" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: searcher, role: "MEMBER", permissions: "0" } });
  const names = {
    percent: { author: "Ops 50% Lead", channel: "fifty%done" },
    underscore: { author: "release_bot", channel: "q4_launch" },
    plain: { author: "Plain Author", channel: "general-talk" },
  };
  for (const k of Object.keys(names) as (keyof typeof names)[]) {
    authors[k] = (await prisma.user.create({ data: { email: `${k}-${stamp}@chs.test`, displayName: names[k].author } })).id;
    await prisma.orgMember.create({ data: { orgId, userId: authors[k], role: "MEMBER", permissions: "0" } });
    channels[k] = (await prisma.chatChannel.create({
      data: { orgId, kind: "CHANNEL", name: names[k].channel, slug: `${k}-${stamp}`, createdById: authors[k] },
    })).id;
    for (const userId of [searcher, authors[k]]) {
      await prisma.chatChannelMember.create({ data: { channelId: channels[k], userId, role: "MEMBER" } });
    }
    messageIds[k] = (await prisma.chatMessage.create({
      data: { channelId: channels[k], authorId: authors[k], content: `status update ${k}` },
    })).id;
  }
});

afterAll(async () => {
  const ids = Object.values(channels);
  await prisma.chatMessage.deleteMany({ where: { channelId: { in: ids } } });
  await prisma.chatChannelMember.deleteMany({ where: { channelId: { in: ids } } });
  await prisma.chatChannel.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: [searcher, ...Object.values(authors)] } } });
});

describe("chat search's from: and in: take the value as text", () => {
  it("control: a plain name finds its author's message and its channel's, and nothing else", async () => {
    expect(await find("from:plain")).toEqual([messageIds.plain]);
    expect(await find("in:#general")).toEqual([messageIds.plain]);
    // Every fixture message is there to be found, so the narrow results below are the filter's.
    expect(await find("status")).toEqual(Object.values(messageIds).sort());
  });

  it("from:% finds only the author whose name has a %", async () => {
    expect(await find("from:%")).toEqual([messageIds.percent]);
  });

  it("from:_ finds only the author whose name has an _", async () => {
    expect(await find("from:@_")).toEqual([messageIds.underscore]);
  });

  it("in:_ finds only the channel whose name has an _", async () => {
    expect(await find("in:_")).toEqual([messageIds.underscore]);
  });

  it("in:% finds only the channel whose name has a %, alongside free text", async () => {
    expect(await find("status in:%")).toEqual([messageIds.percent]);
  });
});
