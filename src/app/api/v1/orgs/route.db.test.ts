// @vitest-environment node
//
// "Your organizations" lists the orgs a person belongs to NOW. Removal keeps
// the membership row for history (removedAt), and the default client hides it
// from direct orgMember reads, but not from a nested `user.memberships` read.
// So the list must filter it itself. Against a real database; only the signed-in
// user is stood in for. Own orgs and user; the seeded users are shared.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const caller = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getCurrentUser: async () => caller.user,
}));

import { prisma } from "@/lib/db/client";
import { GET } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
const orgs = { left: "", kept: "" };
let userId = "";

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `orgs-${stamp}@orgs-list.test`, displayName: "Orgs list" } })).id;
  caller.user = { id: userId };
  // The org they left is created first, so a read that keeps it would list it first.
  for (const which of ["left", "kept"] as const) {
    const orgId = (await prisma.organization.create({ data: { name: `orgs ${which} ${stamp}`, slug: `orgl-${which}-${stamp}` } })).id;
    orgs[which] = orgId;
    await prisma.orgMember.create({
      data: { orgId, userId, role: "MEMBER", permissions: "0", ...(which === "left" ? { removedAt: new Date() } : {}) },
    });
  }
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: Object.values(orgs) } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
});

describe("GET /api/v1/orgs", () => {
  it("lists the orgs the person belongs to, and not the one they were removed from", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { id: string }[]).map((o) => o.id);
    expect(ids).toContain(orgs.kept);
    expect(ids).not.toContain(orgs.left);
    expect(ids).toHaveLength(1);
  });
});
