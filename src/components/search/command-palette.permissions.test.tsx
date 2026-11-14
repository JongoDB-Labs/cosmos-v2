// @vitest-environment jsdom
//
// The ⌘K palette offered Chat to every role, though every chat route needs
// CHAT_USE, so a viewer picked it and landed on the drawer's no-access state.
// It now asks the topbar's own gate (topbar-nav.ts), through `can()`, which
// follows the keys the server sends: a work role can grant CHAT_USE to a
// viewer, and then Chat is offered.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/acme",
}));

import { CommandPalette } from "./command-palette";
import { DrawerProvider } from "@/components/drawers/drawer-provider";
import { PermissionsProvider } from "@/components/providers/permissions-provider";
import { RolePermissions, permissionNames } from "@/lib/rbac/permissions";

async function openPalette(role: keyof typeof RolePermissions, extra: string[] = []) {
  render(
    <PermissionsProvider
      orgs={[{ id: "org-1", slug: "acme", role, permissions: [...permissionNames(RolePermissions[role]), ...extra] }]}
    >
      <DrawerProvider>
        <CommandPalette orgs={[{ id: "org-1", slug: "acme" }]} />
      </DrawerProvider>
    </PermissionsProvider>,
  );
  fireEvent.keyDown(document, { key: "k", metaKey: true });
  // Positive control: the "Go to" list rendered (Work Items needs no permission here).
  await screen.findByText("Work Items");
}

afterEach(cleanup);

describe("CommandPalette offers only what the person may use", () => {
  it("does not offer Chat to a viewer", async () => {
    await openPalette("VIEWER");
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.queryByText("Chat")).toBeNull();
  });

  it("offers Chat to a viewer whose work role grants CHAT_USE", async () => {
    await openPalette("VIEWER", ["CHAT_USE"]);
    expect(screen.getByText("Chat")).toBeInTheDocument();
  });

  it("offers Chat to a member", async () => {
    await openPalette("MEMBER");
    expect(screen.getByText("Chat")).toBeInTheDocument();
  });

  it("hides Notes and Meetings from a guest, as the topbar does", async () => {
    await openPalette("GUEST");
    expect(screen.queryByText("Notes")).toBeNull();
    expect(screen.queryByText("Meetings")).toBeNull();
    expect(screen.queryByText("Chat")).toBeNull();
  });
});
