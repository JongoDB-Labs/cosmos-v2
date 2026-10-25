// @vitest-environment node
//
// What a personal access token can never do, against a real database: reach
// past its owner's live permissions or its project ceiling, outlive its
// revocation, or be read back after it is shown once.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { isProjectVisible } from "@/lib/rbac/project-access";

const h = vi.hoisted(() => ({ userId: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: async () => ({ id: h.userId }),
}));

import { mintApiKey, verifyApiKeyHeader, verifyKeyTokenHolder } from "@/lib/auth/api-key";
import { GET as listTokens } from "./route";
import { DELETE as revokeToken } from "./[tokenId]/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", userId = "", memberId = "", inside = "", outside = "";

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `pat-${stamp}@bounds.test`, displayName: "PAT owner" } })).id;
  h.userId = userId;
  orgId = (await prisma.organization.create({ data: { name: `bounds ${stamp}`, slug: `bounds-${stamp}` } })).id;
  memberId = (await prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER", permissions: "0" } })).id;
  const key = stamp.slice(0, 3).toUpperCase();
  inside = (await prisma.project.create({ data: { orgId, name: "In", key: `BI${key}` } })).id;
  outside = (await prisma.project.create({ data: { orgId, name: "Out", key: `BO${key}` } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
});

const mint = (projectIds: string[] = []) =>
  mintApiKey({
    orgId, name: "ci", scopes: ["items:write"], createdById: userId, projectIds,
    expiresAt: new Date(Date.now() + 86_400_000), kind: "PERSONAL",
  });
const bearer = (token: string) => `Bearer ${token}`;
const has = (mask: bigint, bit: bigint) => (mask & bit) === bit;

describe("a personal token never exceeds its owner or its ceiling", () => {
  it("acts with the owner's live permissions: a demotion binds the token on its next request", async () => {
    const { token } = await mint();
    const before = (await verifyApiKeyHeader(bearer(token), orgId))!;
    expect(has(before.permissions, Permission.ITEM_CREATE)).toBe(true);

    await prisma.orgMember.update({ where: { id: memberId }, data: { role: "VIEWER" } });
    try {
      const after = (await verifyApiKeyHeader(bearer(token), orgId))!;
      expect(has(after.permissions, Permission.ITEM_CREATE)).toBe(false);
    } finally {
      await prisma.orgMember.update({ where: { id: memberId }, data: { role: "MEMBER" } });
    }
  });

  it("dies with the owner's membership", async () => {
    const { token } = await mint();
    await prisma.orgMember.delete({ where: { id: memberId } });
    try {
      expect(await verifyApiKeyHeader(bearer(token), orgId)).toBeNull();
      expect(await verifyKeyTokenHolder(bearer(token))).toBeNull();
    } finally {
      memberId = (await prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER", permissions: "0" } })).id;
    }
  });

  it("reaches only the projects in its ceiling", async () => {
    const { token } = await mint([inside]);
    const ctx = (await verifyApiKeyHeader(bearer(token), orgId))!;
    expect(ctx.projectScope).toEqual([inside]);
    expect(await isProjectVisible(ctx, inside)).toBe(true);
    expect(await isProjectVisible(ctx, outside)).toBe(false);
  });
});

describe("revoking a personal token takes effect at once", () => {
  it("the next request with it is refused, on org routes and on /me", async () => {
    const { token, record } = await mint();
    expect(await verifyApiKeyHeader(bearer(token), orgId)).not.toBeNull();
    const res = await revokeToken(new NextRequest("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ tokenId: record.id }),
    });
    expect(res.status).toBe(204);
    expect(await verifyApiKeyHeader(bearer(token), orgId)).toBeNull();
    expect(await verifyKeyTokenHolder(bearer(token))).toBeNull();
  });
});

describe("the secret is shown once and never stored or echoed", () => {
  it("the row keeps only its hash, and the list never carries the secret or the hash", async () => {
    const { token, record } = await mint();
    const secret = token.split("_").slice(2).join("_");
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: record.id } });
    // A digest, not the secret; and the token still verifies against it.
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(await verifyApiKeyHeader(bearer(token), orgId)).not.toBeNull();

    const listed = await (await listTokens(new NextRequest(`http://localhost/api/v1/me/tokens?orgId=${orgId}`))).text();
    expect(listed).toContain(record.id);
    expect(listed).not.toContain(secret);
    expect(listed).not.toContain(row.keyHash);
    expect(listed).not.toContain("keyHash");
  });
});
