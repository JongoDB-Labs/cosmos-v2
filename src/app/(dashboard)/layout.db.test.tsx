// @vitest-environment node
//
// The dashboard shell lists the person's organizations: the org switcher, and
// the permissions every page reads. Removal keeps the membership row for
// history (removedAt), which a nested `user.memberships` read does not hide, so
// the shell filters it itself. This renders the shell's data step against a
// real database and reads the orgs it hands on; only the signed-in user is
// stood in for. Own orgs and user; the seeded users are shared.
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

const caller = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getCurrentUser: async () => caller.user,
}));

import { prisma } from "@/lib/db/client";
import DashboardLayout from "./layout";

const stamp = Math.random().toString(36).slice(2, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

async function org(label: string) {
  const o = await prisma.organization.create({ data: { name: `shell ${label} ${stamp}`, slug: `shell-${label}-${stamp}` } });
  orgIds.push(o.id);
  return o;
}

type Element = ReactElement<{ children?: ReactNode; orgs?: { id: string }[] }>;

/** Depth-first: the first element whose props carry `orgs`. */
function findOrgs(node: unknown): string[] | null {
  if (!node || typeof node !== "object") return null;
  const props = (node as Element).props;
  if (props?.orgs) return props.orgs.map((o) => o.id);
  const kids = props?.children;
  for (const child of Array.isArray(kids) ? kids : [kids]) {
    const found = findOrgs(child);
    if (found) return found;
  }
  return null;
}

/** The layout's own tree is static; its data step is the async child inside Suspense. Run that step. */
async function shellOrgs(): Promise<string[] | null> {
  let node: unknown = DashboardLayout({ children: null });
  // QueryProvider > Suspense > AuthedShell
  for (let i = 0; i < 4 && node && typeof node === "object"; i++) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
      return findOrgs(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
    }
    node = el.props?.children;
  }
  throw new Error("the layout's async data step was not found");
}

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

describe("the dashboard shell lists only the orgs a person still belongs to", () => {
  it("hands the switcher every current org and not the one they left", async () => {
    const left = await org("left");
    const a = await org("a");
    const b = await org("b");
    const id = (await prisma.user.create({ data: { email: `shell-${stamp}@shell.test`, displayName: "Shell" } })).id;
    userIds.push(id);
    await prisma.orgMember.create({ data: { orgId: left.id, userId: id, role: "MEMBER", permissions: "0", removedAt: new Date() } });
    await prisma.orgMember.create({ data: { orgId: a.id, userId: id, role: "MEMBER", permissions: "0" } });
    await prisma.orgMember.create({ data: { orgId: b.id, userId: id, role: "ADMIN", permissions: "0" } });
    caller.user = { id, email: `shell-${stamp}@shell.test`, authMethod: "password", idpConnId: null };

    const orgs = await shellOrgs();
    // Positive control: the walk found the orgs at all, and both current ones.
    expect(orgs?.sort()).toEqual([a.id, b.id].sort());
  });
});
