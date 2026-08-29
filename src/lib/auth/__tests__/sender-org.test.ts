// @vitest-environment node
//
// Which org's mail configuration sends to a given address.
//
// The bug this fixes: resolution looked only at memberships, so an invited-but-
// not-yet-joined account resolved NOTHING and its reset mail fell through to a
// deployment-wide config that was unset. The people most likely to need a reset
// were the only ones structurally guaranteed not to get one.
//
// The order is also a security boundary: `orgSlug` comes off the login screen,
// so honouring one the user does not belong to would let any org ask another to
// send mail on its behalf.
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above every const, so the spy has to be hoisted with it.
const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { invitation: { findFirst } } }));

import { resolveSenderOrg } from "../sender-org";

const A = { id: "org-a", slug: "alpha" };
const B = { id: "org-b", slug: "beta" };
const member = (...orgs: { id: string; slug: string }[]) => orgs.map((org) => ({ org }));

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
});

describe("membership wins, and the named org must be one of them", () => {
  it("prefers the org named on the login screen when they belong to it", async () => {
    const out = await resolveSenderOrg({ email: "a@x.test", orgSlug: "beta", memberships: member(A, B) });
    expect(out).toEqual({ ...B, source: "named" });
  });

  it("ignores a named org they do NOT belong to, rather than sending as it", async () => {
    const out = await resolveSenderOrg({ email: "a@x.test", orgSlug: "beta", memberships: member(A) });
    expect(out).toEqual({ ...A, source: "membership" });
  });

  it("falls back to a membership when no org is named", async () => {
    const out = await resolveSenderOrg({ email: "a@x.test", memberships: member(A) });
    expect(out).toEqual({ ...A, source: "membership" });
  });

  it("never consults invitations while a membership exists", async () => {
    await resolveSenderOrg({ email: "a@x.test", memberships: member(A) });
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("with no membership, the org that invited them sends", () => {
  it("resolves the inviting org — the case that was broken", async () => {
    findFirst.mockResolvedValue({ org: B });
    const out = await resolveSenderOrg({ email: "invitee@x.test", memberships: [] });
    expect(out).toEqual({ ...B, source: "invitation" });
  });

  it("only counts invitations that have not expired", async () => {
    await resolveSenderOrg({ email: "invitee@x.test", memberships: [] });
    const where = findFirst.mock.calls[0][0].where;
    expect(where.expiresAt).toBeDefined();
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it("matches the address case-insensitively", async () => {
    await resolveSenderOrg({ email: "Invitee@X.test", memberships: [] });
    expect(findFirst.mock.calls[0][0].where.email).toEqual({
      equals: "Invitee@X.test",
      mode: "insensitive",
    });
  });

  it("takes the newest invitation when several orgs are courting them", async () => {
    await resolveSenderOrg({ email: "invitee@x.test", memberships: [] });
    expect(findFirst.mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
  });

  it("returns null when there is neither a membership nor an invitation", async () => {
    expect(await resolveSenderOrg({ email: "nobody@x.test", memberships: [] })).toBeNull();
  });
});
