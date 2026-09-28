import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { rosterOf } from "./time-off";

/**
 * The bug this file exists for: the Time off screen called `.map` on the
 * roster RESPONSE rather than on the list inside it, and took the whole screen
 * down on first load — "(k.data ?? []).map is not a function" — over the names
 * it wanted, which were the least important thing on the page.
 *
 * `jsonFetch<T>` is a CAST, not a check, so neither the compiler nor any route
 * test could see it. The second describe below is therefore the one that
 * matters: it pins the shape the real endpoint answers with, so the screen and
 * the route cannot drift apart again in silence.
 */

describe("rosterOf", () => {
  const person = { userId: "u1", displayName: "Ada", isSelf: true };

  it("reads the list out of the envelope the endpoint sends", () => {
    expect(rosterOf({ data: [person], total: 1 })).toEqual([person]);
  });

  it("accepts a bare array, in case the envelope is ever dropped", () => {
    expect(rosterOf([person])).toEqual([person]);
  });

  it("is an empty list before the request lands", () => {
    expect(rosterOf(undefined)).toEqual([]);
    expect(rosterOf(null)).toEqual([]);
  });

  it("does not hand back a non-array when the body is malformed", () => {
    // The exact failure: something that is not a list reaching `.map`.
    const junk = { data: { nope: true }, total: 0 } as unknown as Parameters<typeof rosterOf>[0];
    expect(rosterOf(junk)).toEqual([]);
  });
});

// ── the contract, pinned against the real route ──────────────────────────────

const { prisma, getAuthContext, readableTimePeople } = vi.hoisted(() => ({
  prisma: { organization: { findUnique: vi.fn() } },
  getAuthContext: vi.fn(),
  readableTimePeople: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/time/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/time/scope")>();
  return { ...actual, readableTimePeople: (...a: unknown[]) => readableTimePeople(...a) };
});

const ORG_ID = "11111111-1111-4111-8111-111111111111";

describe("the roster endpoint answers the shape the screen reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "o" });
    const permissions = Permission.TIME_READ;
    getAuthContext.mockResolvedValue({
      userId: "u1",
      orgId: ORG_ID,
      orgRole: OrgRole.MEMBER,
      permissions,
      basePermissions: permissions,
      abacRules: [],
    } as AuthContext);
    readableTimePeople.mockResolvedValue([
      { userId: "u1", displayName: "Ada", isSelf: true },
    ]);
  });

  it("puts the list under `data`, beside a `total`, and rosterOf reads it", async () => {
    const { GET } = await import("@/app/api/v1/orgs/[orgId]/time-entries/people/route");
    const res = await GET(
      new NextRequest("http://localhost/api/v1/orgs/o/time-entries/people"),
      { params: Promise.resolve({ orgId: ORG_ID }) },
    );
    const body = await res.json();

    // TWO top-level keys is the whole point: jsonFetch only unwraps a lone
    // `data`, so the screen receives this object rather than the array.
    expect(Object.keys(body).sort()).toEqual(["data", "total"]);
    expect(Array.isArray(body.data)).toBe(true);

    // And the screen's reader survives it.
    expect(rosterOf(body).map((p) => p.userId)).toEqual(["u1"]);
  });
});
