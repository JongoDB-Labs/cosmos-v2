// @vitest-environment node
//
// The home page lists the person's organizations, and sends them straight into
// the org when there is exactly one. Removal keeps the membership row for
// history (removedAt), which a nested `user.memberships` read does not hide, so
// the page must filter it itself. Unfiltered, someone removed from their only
// org was redirected into it, and that org refused them. Against a real
// database; only the signed-in user and `redirect` are stood in for.
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const caller = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getCurrentUser: async () => caller.user,
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

import { prisma } from "@/lib/db/client";
import DashboardHomePage from "./page";

const stamp = Math.random().toString(36).slice(2, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

async function org(label: string) {
  const o = await prisma.organization.create({ data: { name: `home ${label} ${stamp}`, slug: `homep-${label}-${stamp}` } });
  orgIds.push(o.id);
  return o;
}

/** A user with the given memberships, in order, signed in as the caller. */
async function signedIn(label: string, memberships: { orgId: string; removed: boolean }[]) {
  const id = (await prisma.user.create({ data: { email: `home-${label}-${stamp}@home.test`, displayName: label } })).id;
  userIds.push(id);
  for (const m of memberships) {
    await prisma.orgMember.create({
      data: { orgId: m.orgId, userId: id, role: "MEMBER", permissions: "0", ...(m.removed ? { removedAt: new Date() } : {}) },
    });
  }
  caller.user = { id, email: `home-${label}-${stamp}@home.test`, authMethod: "password", idpConnId: null };
}

/** Where the page redirected, or null when it rendered. */
async function visit(): Promise<{ redirect: string | null; page: ReactElement | null }> {
  try {
    return { redirect: null, page: (await DashboardHomePage()) as ReactElement };
  } catch (e) {
    const m = e instanceof Error ? /^REDIRECT (.*)$/.exec(e.message) : null;
    if (m) return { redirect: m[1], page: null };
    throw e;
  }
}

/** The ids of the orgs the picker shows, from the rendered tree. */
function pickerOrgIds(node: unknown): string[] | null {
  if (!node || typeof node !== "object") return null;
  const props = (node as { props?: { orgs?: { id: string }[]; children?: unknown } }).props;
  if (props?.orgs) return props.orgs.map((o) => o.id);
  const kids = props?.children;
  for (const child of Array.isArray(kids) ? kids : [kids]) {
    const found = pickerOrgIds(child);
    if (found) return found;
  }
  return null;
}

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

describe("the home page lists only the orgs a person still belongs to", () => {
  it("someone removed from their only org is not sent into it", async () => {
    const left = await org("only");
    await signedIn("only", [{ orgId: left.id, removed: true }]);
    const { redirect, page } = await visit();
    expect(redirect).toBeNull();
    // The empty state, with no picker at all.
    expect(pickerOrgIds(page)).toBeNull();
  });

  it("with one org left after a removal, it goes straight to that one", async () => {
    const left = await org("left");
    const kept = await org("kept");
    await signedIn("one-left", [{ orgId: left.id, removed: true }, { orgId: kept.id, removed: false }]);
    expect((await visit()).redirect).toBe(`/${kept.slug}`);
  });

  it("the picker shows every current org and not the one they left", async () => {
    const left = await org("pick-left");
    const a = await org("pick-a");
    const b = await org("pick-b");
    await signedIn("picker", [
      { orgId: left.id, removed: true },
      { orgId: a.id, removed: false },
      { orgId: b.id, removed: false },
    ]);
    const { redirect, page } = await visit();
    expect(redirect).toBeNull();
    expect(pickerOrgIds(page)?.sort()).toEqual([a.id, b.id].sort());
  });
});
