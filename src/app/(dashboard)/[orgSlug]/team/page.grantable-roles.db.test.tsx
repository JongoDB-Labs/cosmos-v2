// @vitest-environment node
//
// The Org page tells its two role pickers (the invite dialog, and the tier in
// the role dialog) which org roles the viewer may give: `grantableOrgRoles`,
// the rule the server's own grant ceiling uses. Before, both offered Admin and
// Billing admin to anyone who could open them, and the server refused.
//
// Against a real database and the real `getAuthContext`: only `next/headers`
// is stood in for, and the page's client parts, so the props it hands them can
// be read. Own org and users; the seeded users are shared.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const h = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => h.headers,
  cookies: async () => ({
    get: (name: string) => {
      const m = (h.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
      return m ? { name, value: m[1] } : undefined;
    },
  }),
}));
// getAuthContext is wrapped in React's per-request `cache`; every call here is its own request.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/app/(dashboard)/[orgSlug]/team/team-table", () => ({ TeamTable: () => null }));
vi.mock("@/app/(dashboard)/[orgSlug]/team/invite-member-button", () => ({ InviteMemberButton: () => null }));
vi.mock("@/app/(dashboard)/[orgSlug]/team/account-request-queue", () => ({ AccountRequestQueue: () => null }));

import { prisma } from "@/lib/db/client";
import { createTestSession } from "@/lib/testing/sessions";
import { Permission, maskToDb } from "@/lib/rbac/permissions";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { getAuthContext } from "@/lib/auth/session";
import { grantableOrgRoles } from "@/lib/rbac/grant-ceiling";
import TeamPage from "./page";
import { TeamTable } from "./team-table";
import { InviteMemberButton } from "./invite-member-button";

const stamp = Math.random().toString(36).slice(2, 8);
const slug = `grantable-${stamp}`;
let orgId = "";
const users: string[] = [];
const as = {} as Record<"owner" | "manager", Headers>;

async function person(role: "OWNER" | "MEMBER", workRoleId?: string): Promise<Headers> {
  const n = users.length;
  const userId = (await prisma.user.create({
    data: { email: `g${n}-${stamp}@grantable.test`, displayName: `Grantable ${n}` },
  })).id;
  users.push(userId);
  const memberId = (await prisma.orgMember.create({ data: { orgId, userId, role, permissions: maskToDb(0n) } })).id;
  if (workRoleId) await prisma.orgMemberWorkRole.create({ data: { orgMemberId: memberId, workRoleId } });
  const token = await createTestSession({ userId, expiresAt: new Date(Date.now() + 60 * 60_000), authMethod: "password", mfaSatisfied: true });
  return new Headers({ cookie: `${SESSION_COOKIE}=${token}` });
}

/** The props the Org page hands `component`, rendered as `who`. Walks every prop, since the invite button rides in `actions`. */
async function propsOf(who: Headers, component: unknown): Promise<Record<string, unknown>> {
  h.headers = who;
  type El = ReactElement<Record<string, unknown>>;
  const suspense = TeamPage({ params: Promise.resolve({ orgSlug: slug }) }) as El;
  const content = suspense.props.children as El;
  const tree = await (content.type as (p: unknown) => Promise<unknown>)(content.props);
  const find = (n: unknown): Record<string, unknown> | null => {
    if (!n || typeof n !== "object") return null;
    if (Array.isArray(n)) {
      for (const k of n) {
        const hit = find(k);
        if (hit) return hit;
      }
      return null;
    }
    const el = n as El;
    if (el.type === component) return el.props;
    for (const v of Object.values(el.props ?? {})) {
      const hit = find(v);
      if (hit) return hit;
    }
    return null;
  };
  const props = find(tree);
  if (!props) throw new Error("the Org page did not render that part");
  return props;
}

async function grantableFor(who: Headers) {
  h.headers = who;
  const ctx = await getAuthContext(slug);
  if (!ctx) throw new Error("no auth context");
  return grantableOrgRoles(ctx);
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `grantable ${stamp}`, slug } })).id;
  const managerRole = await prisma.workRole.create({
    data: { orgId, key: `members-${stamp}`, name: "Member manager", grants: maskToDb(Permission.ORG_MANAGE_MEMBERS) },
  });
  as.owner = await person("OWNER");
  as.manager = await person("MEMBER", managerRole.id);
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
});

describe("the Org page offers only the org roles the viewer may grant", () => {
  it("a member who manages members through a work role is offered no Admin and no Billing admin", async () => {
    const invite = await propsOf(as.manager, InviteMemberButton);
    const table = await propsOf(as.manager, TeamTable);
    expect(invite.grantableRoles).toEqual(await grantableFor(as.manager));
    expect(invite.grantableRoles).toEqual(["MEMBER", "VIEWER", "GUEST"]);
    expect(table.grantableTiers).toEqual(invite.grantableRoles);
  });

  it("an owner is offered every role (control)", async () => {
    const invite = await propsOf(as.owner, InviteMemberButton);
    const table = await propsOf(as.owner, TeamTable);
    expect(invite.grantableRoles).toEqual(["OWNER", "ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER", "GUEST"]);
    expect(table.grantableTiers).toEqual(invite.grantableRoles);
  });
});
