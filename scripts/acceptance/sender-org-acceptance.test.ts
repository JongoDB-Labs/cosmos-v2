// @vitest-environment node
//
// ACCEPTANCE — needs a real Postgres. Invoke explicitly:
//   DATABASE_URL=... npx vitest run --config vitest.acceptance.config.ts
//
// Proves against a real database the case that was broken in production: a person
// who has been invited but has not yet accepted belongs to no organisation, and
// so resolved NO sending org at all. Their reset mail fell through to a
// deployment-wide configuration that was unset, and threw. The people most likely
// to need a reset link were the only ones structurally guaranteed not to get one.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { resolveSenderOrg } from "@/lib/auth/sender-org";

const ORG_A = "5f000000-0000-4000-8000-0000000000b1";
const ORG_B = "5f000000-0000-4000-8000-0000000000b2";
const EMAIL = "sender-org@acceptance.invalid";

const wipe = () => prisma.invitation.deleteMany({ where: { email: { contains: "acceptance.invalid" } } });

beforeAll(async () => {
  for (const [id, slug] of [[ORG_A, "sender-a"], [ORG_B, "sender-b"]] as const) {
    await prisma.organization.upsert({
      where: { id },
      create: { id, name: `Sender ${slug}`, slug },
      update: {},
    });
  }
  await wipe();
});
afterAll(wipe);

const invite = (orgId: string, expiresAt: Date, email = EMAIL) =>
  prisma.invitation.create({
    data: { orgId, email, role: "MEMBER", expiresAt },
    select: { id: true },
  });

const HOUR = 3600_000;

describe("an invited-but-not-yet-joined address still resolves a sender", () => {
  it("resolves the inviting org — no membership needed", async () => {
    await invite(ORG_A, new Date(Date.now() + 24 * HOUR));
    const out = await resolveSenderOrg({ email: EMAIL, memberships: [] });
    expect(out).toMatchObject({ id: ORG_A, slug: "sender-a", source: "invitation" });
  });

  it("matches the address case-insensitively, as the reset route normalises it", async () => {
    const out = await resolveSenderOrg({ email: EMAIL.toUpperCase(), memberships: [] });
    expect(out?.id).toBe(ORG_A);
  });

  it("prefers the newest invitation when two orgs have invited them", async () => {
    await invite(ORG_B, new Date(Date.now() + 24 * HOUR));
    const out = await resolveSenderOrg({ email: EMAIL, memberships: [] });
    expect(out?.id).toBe(ORG_B);
  });

  it("ignores an expired invitation rather than sending as a stale org", async () => {
    await wipe();
    await invite(ORG_A, new Date(Date.now() - HOUR));
    expect(await resolveSenderOrg({ email: EMAIL, memberships: [] })).toBeNull();
  });

  it("returns null for an address nobody has invited (env fallback, as before)", async () => {
    await wipe();
    expect(await resolveSenderOrg({ email: "stranger@acceptance.invalid", memberships: [] })).toBeNull();
  });
});
