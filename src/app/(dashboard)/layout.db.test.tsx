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
import { PermissionsProvider } from "@/components/providers/permissions-provider";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { Permission, RolePermissions, maskToDb, permissionNames } from "@/lib/rbac/permissions";

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
async function shellTree(): Promise<unknown> {
  let node: unknown = DashboardLayout({ children: null });
  // QueryProvider > Suspense > AuthedShell
  for (let i = 0; i < 4 && node && typeof node === "object"; i++) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
      return (el.type as (p: unknown) => Promise<unknown>)(el.props);
    }
    node = el.props?.children;
  }
  throw new Error("the layout's async data step was not found");
}

async function shellOrgs(): Promise<string[] | null> {
  return findOrgs(await shellTree());
}

type ProviderOrg = Record<string, unknown> & { id: string; permissions: unknown };

/** The orgs the shell hands the permissions provider, which every page's `can()` reads. */
async function providerOrgs(): Promise<ProviderOrg[]> {
  const find = (node: unknown): ProviderOrg[] | null => {
    if (!node || typeof node !== "object") return null;
    const el = node as ReactElement<{ children?: ReactNode; orgs?: ProviderOrg[] }>;
    if (el.type === PermissionsProvider) return el.props.orgs ?? null;
    const kids = el.props?.children;
    for (const child of Array.isArray(kids) ? kids : [kids]) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  const orgs = find(await shellTree());
  if (!orgs) throw new Error("the shell rendered no permissions provider");
  return orgs;
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

describe("the shell sends each org's effective permissions, as keys", () => {
  async function person(label: string) {
    const id = (await prisma.user.create({ data: { email: `perm-${label}-${stamp}@shell.test`, displayName: label } })).id;
    userIds.push(id);
    caller.user = { id, email: `perm-${label}-${stamp}@shell.test`, authMethod: "password", idpConnId: null };
    return id;
  }

  it("folds in a work role, a stored override and the org's restriction, as the server's checks do", async () => {
    const r = await org("restricted");
    const other = await org("other");
    // An unconditional deny on a bit the viewer's role holds.
    await prisma.orgSecuritySettings.create({
      data: { orgId: r.id, actionRestrictions: [{ effect: "deny", actions: ["COMMENT_READ"], conditions: [] }] },
    });
    const chatRole = await prisma.workRole.create({
      data: { orgId: r.id, key: `chat-${stamp}`, name: "Chat", grants: maskToDb(Permission.CHAT_USE) },
    });
    const id = await person("viewer");
    const m = await prisma.orgMember.create({
      data: { orgId: r.id, userId: id, role: "VIEWER", permissions: maskToDb(Permission.NOTE_CREATE) },
    });
    await prisma.orgMemberWorkRole.create({ data: { orgMemberId: m.id, workRoleId: chatRole.id } });
    await prisma.orgMember.create({ data: { orgId: other.id, userId: id, role: "MEMBER", permissions: "0" } });

    const orgs = await providerOrgs();
    const sent = orgs.find((o) => o.id === r.id);
    const server = await loadEffectivePermissions(r.id, id);
    if (!sent || !server) throw new Error("the restricted org is missing from the shell or the server");

    // Exactly what the server's own checks hold.
    expect([...(sent.permissions as string[])].sort()).toEqual(permissionNames(server.permissions).sort());
    // The fixture exercises all three: the work role, the override, the restriction.
    expect(sent.permissions).toContain("CHAT_USE");
    expect(sent.permissions).toContain("NOTE_CREATE");
    expect(sent.permissions).not.toContain("COMMENT_READ");
    // Control: the role alone says the opposite on each, which is what can() read before.
    const roleOnly = permissionNames(RolePermissions.VIEWER);
    expect(roleOnly).not.toContain("CHAT_USE");
    expect(roleOnly).not.toContain("NOTE_CREATE");
    expect(roleOnly).toContain("COMMENT_READ");

    // Each org its own: the unrestricted one is a plain member's.
    const plain = orgs.find((o) => o.id === other.id);
    expect([...((plain?.permissions as string[]) ?? [])].sort()).toEqual(permissionNames(RolePermissions.MEMBER).sort());

    // Keys only: every value is a permission's name, and no org carries a mask.
    for (const o of orgs) {
      expect((o.permissions as string[]).every((k) => Object.hasOwn(Permission, k))).toBe(true);
      expect(Object.values(o).some((v) => typeof v === "bigint" || (typeof v === "string" && /^\d{10,}$/.test(v)))).toBe(false);
    }
  });

  it("gives an owner's session the restricted bits back, as the server does", async () => {
    const r = await org("owner");
    await prisma.orgSecuritySettings.create({
      data: { orgId: r.id, actionRestrictions: [{ effect: "deny", actions: ["ITEM_DELETE"], conditions: [] }] },
    });
    const id = await person("owner");
    await prisma.orgMember.create({ data: { orgId: r.id, userId: id, role: "OWNER", permissions: "0" } });

    const sent = (await providerOrgs()).find((o) => o.id === r.id);
    const server = await loadEffectivePermissions(r.id, id);
    expect(server && permissionNames(server.permissions)).toContain("ITEM_DELETE");
    expect([...((sent?.permissions as string[]) ?? [])].sort()).toEqual(permissionNames(server!.permissions).sort());
  });
});
