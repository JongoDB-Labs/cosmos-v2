// @vitest-environment jsdom
//
// The phone's bottom bar kept Chat fixed in its centre for every role, though
// every chat route needs CHAT_USE. It now shows Chat only to someone who may
// use it, by `can()`, which follows the keys the server sends (a work role can
// grant CHAT_USE to a viewer).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme" }));
vi.mock("@/hooks/use-total-unread", () => ({ useTotalUnread: () => 0 }));

import { MobileBottomNav } from "./mobile-bottom-nav";
import { DrawerProvider } from "@/components/drawers/drawer-provider";
import { PermissionsProvider } from "@/components/providers/permissions-provider";
import { RolePermissions, permissionNames } from "@/lib/rbac/permissions";

function bar(role: keyof typeof RolePermissions, extra: string[] = []) {
  render(
    <PermissionsProvider
      orgs={[{ id: "org-1", slug: "acme", role, permissions: [...permissionNames(RolePermissions[role]), ...extra] }]}
    >
      <DrawerProvider>
        <MobileBottomNav orgSlug="acme" orgId="org-1" />
      </DrawerProvider>
    </PermissionsProvider>,
  );
  const nav = screen.getByRole("navigation", { name: "Primary (mobile)" });
  // Positive control: the bar's own slots rendered.
  expect(within(nav).getByRole("link", { name: "Overview" })).toBeInTheDocument();
  return nav;
}

afterEach(cleanup);

describe("MobileBottomNav shows Chat only to someone who may use it", () => {
  it("has no Chat for a viewer, and keeps its four slots", () => {
    const nav = bar("VIEWER");
    expect(within(nav).queryByRole("button", { name: "Chat" })).toBeNull();
    expect(within(nav).getAllByRole("link")).toHaveLength(4);
  });

  it("has Chat for a viewer whose work role grants CHAT_USE", () => {
    const nav = bar("VIEWER", ["CHAT_USE"]);
    expect(within(nav).getByRole("button", { name: "Chat" })).toBeInTheDocument();
  });

  it("has Chat for a member", () => {
    const nav = bar("MEMBER");
    expect(within(nav).getByRole("button", { name: "Chat" })).toBeInTheDocument();
  });
});
