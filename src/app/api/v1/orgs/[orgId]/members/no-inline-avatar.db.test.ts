// @vitest-environment node
//
// Avatars are stored as `data:` URIs on User.avatarUrl. The members list sent
// them inline, so three avatars accounted for 93% of a 171KB response — and
// base64 does not compress, so the proxy's `encode` could not reduce it. The
// list must now carry a URL to the avatar endpoint instead.
//
// This asserts the PROPERTY end to end against a real database: no `data:`
// payload reaches the wire, and the response is smaller than the avatar it
// used to contain.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
// Deliberately large: ~60KB of base64, the order of the real offender.
const BIG_AVATAR = `data:image/png;base64,${"A".repeat(60_000)}`;

let orgId = "", withAvatar = "", without = "";

const at = () => ({ params: Promise.resolve({ orgId }) });
const req = () => new NextRequest(`http://localhost/api/v1/orgs/${orgId}/members`);

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `inl ${stamp}`, slug: `inl-${stamp}` } })).id;
  withAvatar = (await prisma.user.create({ data: { email: `a-${stamp}@inl.test`, displayName: "Has Avatar", avatarUrl: BIG_AVATAR } })).id;
  without = (await prisma.user.create({ data: { email: `b-${stamp}@inl.test`, displayName: "No Avatar", avatarUrl: null } })).id;
  for (const userId of [withAvatar, without]) {
    await prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER", permissions: "0" } });
  }
  h.ctx = { userId: withAvatar, orgId, orgRole: "MEMBER", abacRules: [], basePermissions: 0n, permissions: Permission.ORG_READ } satisfies AuthContext;
});

afterAll(async () => {
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: [withAvatar, without] } } });
});

describe("the members list does not inline avatar bytes", () => {
  it("sends a URL to the avatar endpoint, and never the data: URI", async () => {
    const res = await GET(req(), at());
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).not.toContain("data:");
    expect(text).not.toContain("base64");
    expect(text).not.toContain("AAAAAAAAAA");

    const body = JSON.parse(text);
    const rows = (body.data ?? body) as Array<{ user: { id: string; avatarUrl: string | null } }>;
    const mine = rows.find((r) => r.user.id === withAvatar);
    expect(mine?.user.avatarUrl).toMatch(
      new RegExp(`^/api/v1/orgs/${orgId}/users/${withAvatar}/avatar\\?v=[0-9a-f]+$`),
    );
    expect(rows.find((r) => r.user.id === without)?.user.avatarUrl).toBeNull();
  });

  it("is smaller than the single avatar it used to carry", async () => {
    const text = await (await GET(req(), at())).text();
    // The point of the change, stated as a number: the whole roster response
    // now weighs less than one inlined avatar did.
    expect(text.length).toBeLessThan(BIG_AVATAR.length);
  });
});
