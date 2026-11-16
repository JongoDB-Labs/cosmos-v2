// @vitest-environment jsdom
//
// `can()` answers from the permission KEYS the server sends for each org, which
// it computes with the same fold as its own checks: role, the member's stored
// override, work-role grants, and the org's restrictions. It used to answer
// from the org role alone, so a viewer whose work role grants chat was told
// they couldn't use it, and a member under a restriction was shown controls
// the server refuses.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ pathname: "/acme" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

import { PermissionsProvider, usePermissions } from "./permissions-provider";
import {
  Permission,
  RolePermissions,
  permissionMaskFromKeys,
  permissionNames,
  type PermissionKey,
} from "@/lib/rbac/permissions";

const keysOf = (mask: bigint) => permissionNames(mask);

function Probe() {
  const { can, permissions, orgId } = usePermissions();
  const asks: PermissionKey[] = ["CHAT_USE", "ITEM_CREATE", "ITEM_UPDATE", "ORG_MANAGE_MEMBERS"];
  return (
    <ul>
      <li data-testid="org">{orgId}</li>
      <li data-testid="mask">{permissions.toString()}</li>
      {asks.map((k) => (
        <li key={k} data-testid={k}>{String(can(Permission[k]))}</li>
      ))}
    </ul>
  );
}

type TestOrg = { id: string; slug: string; role: string; permissions: string[] };
function renderWith(orgs: TestOrg[]) {
  render(
    <PermissionsProvider orgs={orgs}>
      <Probe />
    </PermissionsProvider>,
  );
  const read = (k: string) => screen.getByTestId(k).textContent;
  return { read };
}

afterEach(() => {
  cleanup();
  nav.pathname = "/acme";
});

describe("PermissionsProvider builds can() from the keys the server sends", () => {
  it("a viewer whose work role grants chat may use chat", () => {
    const { read } = renderWith([
      { id: "org-1", slug: "acme", role: "VIEWER", permissions: [...keysOf(RolePermissions.VIEWER), "CHAT_USE"] },
    ]);
    expect(read("CHAT_USE")).toBe("true");
    // Control: the rest is still a viewer's.
    expect(read("ITEM_CREATE")).toBe("false");
  });

  it("a member under a restriction on creating items may not create them", () => {
    const { read } = renderWith([
      { id: "org-1", slug: "acme", role: "MEMBER", permissions: keysOf(RolePermissions.MEMBER & ~Permission.ITEM_CREATE) },
    ]);
    expect(read("ITEM_CREATE")).toBe("false");
    // Control: what the restriction leaves is still there.
    expect(read("ITEM_UPDATE")).toBe("true");
    expect(read("CHAT_USE")).toBe("true");
  });

  it("a member's stored override counts", () => {
    const { read } = renderWith([
      {
        id: "org-1", slug: "acme", role: "MEMBER",
        permissions: keysOf(RolePermissions.MEMBER | Permission.ORG_MANAGE_MEMBERS),
      },
    ]);
    expect(read("ORG_MANAGE_MEMBERS")).toBe("true");
  });

  it("answers for the org in the URL, from that org's own keys", () => {
    nav.pathname = "/beta/projects";
    const { read } = renderWith([
      { id: "org-a", slug: "acme", role: "MEMBER", permissions: keysOf(RolePermissions.MEMBER) },
      { id: "org-b", slug: "beta", role: "MEMBER", permissions: keysOf(RolePermissions.VIEWER) },
    ]);
    expect(read("org")).toBe("org-b");
    expect(read("ITEM_UPDATE")).toBe("false");
  });

  it("the mask it exposes is the keys' mask, and an unknown key sets nothing", () => {
    const keys = [...keysOf(RolePermissions.GUEST), "NOT_A_PERMISSION"];
    const { read } = renderWith([{ id: "org-1", slug: "acme", role: "GUEST", permissions: keys }]);
    expect(read("mask")).toBe(permissionMaskFromKeys(keys).toString());
    expect(read("mask")).toBe(RolePermissions.GUEST.toString());
  });
});
