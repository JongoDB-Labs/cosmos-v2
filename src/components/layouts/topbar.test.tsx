// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// Topbar pulls in several client hooks/providers; stub them so we can render
// the header in isolation and assert on the sidebar-toggle's accessible name.
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/providers/permissions-provider", () => ({
  usePermissions: () => ({ can: () => true }),
}));
vi.mock("@/components/drawers/drawer-provider", () => ({
  useDrawers: () => ({ openDrawer: () => {}, isOpen: () => false }),
}));
vi.mock("@/hooks/use-total-unread", () => ({ useTotalUnread: () => 0 }));

import { Topbar } from "./topbar";

afterEach(cleanup);

describe("Topbar sidebar toggle", () => {
  it("exposes a state-aware accessible name when the sidebar is expanded", () => {
    render(
      <Topbar orgs={[]} sidebarExpanded onToggleSidebar={() => {}} />,
    );
    expect(
      screen.getByRole("button", { name: "Collapse sidebar" }),
    ).toBeInTheDocument();
  });

  it("exposes a state-aware accessible name when the sidebar is collapsed", () => {
    render(
      <Topbar orgs={[]} sidebarExpanded={false} onToggleSidebar={() => {}} />,
    );
    expect(
      screen.getByRole("button", { name: "Expand sidebar" }),
    ).toBeInTheDocument();
  });
});
