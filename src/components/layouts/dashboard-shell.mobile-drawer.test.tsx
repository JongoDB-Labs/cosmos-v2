// @vitest-environment jsdom
//
// COSMOS-151: on a phone, tapping a link in the nav drawer changed the page but
// left the drawer open on top of it. It must close when the route changes.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const { nav } = vi.hoisted(() => ({ nav: { pathname: "/acme" } }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));
vi.mock("@/lib/hooks/use-media-query", () => ({ useMediaQuery: () => true }));
vi.mock("@/lib/hooks/use-main-scroll", () => ({
  useHashAnchorScroll: () => {},
  useMainScrollRestorer: () => {},
}));
vi.mock("./app-sidebar", () => ({ AppSidebar: () => <nav aria-label="Drawer nav">links</nav> }));
vi.mock("./topbar", () => ({
  Topbar: ({ onToggleSidebar }: { onToggleSidebar: () => void }) => (
    <button onClick={onToggleSidebar}>Open menu</button>
  ),
}));
vi.mock("./mobile-bottom-nav", () => ({ MobileBottomNav: () => null }));
vi.mock("./floating-agent-bubble", () => ({ FloatingAgentBubble: () => null }));
vi.mock("@/components/wake-word/wake-word-provider", () => ({ WakeWordProvider: () => null }));
vi.mock("@/components/drawers/drawer-provider", () => ({
  DrawerProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/tour/tour-provider", () => ({
  TourProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/tour/tour-card", () => ({ TourCard: () => null }));
vi.mock("@/components/drawers/docked-drawer", () => ({ DockedDrawer: () => null }));

import { DashboardShell } from "./dashboard-shell";

const user = { id: "u1", email: "u@example.com", displayName: "U", avatarUrl: null };
const orgs = [{ id: "o1", name: "Acme", slug: "acme", plan: "free", logoUrl: null, role: "MEMBER" }];

afterEach(() => {
  cleanup();
  nav.pathname = "/acme";
});

describe("DashboardShell — mobile nav drawer", () => {
  it("closes when a link takes you to another page", async () => {
    // Different children on each render, so React cannot bail out of the
    // re-render that carries the new pathname.
    const { rerender } = render(
      <DashboardShell user={user} orgs={orgs}><p>overview</p></DashboardShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(await screen.findByRole("navigation", { name: "Drawer nav" })).toBeTruthy();

    nav.pathname = "/acme/issues";
    rerender(<DashboardShell user={user} orgs={orgs}><p>issues</p></DashboardShell>);

    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Drawer nav" })).toBeNull());
  });

  it("stays open across a re-render on the same page", async () => {
    const { rerender } = render(
      <DashboardShell user={user} orgs={orgs}><p>a</p></DashboardShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(await screen.findByRole("navigation", { name: "Drawer nav" })).toBeTruthy();

    rerender(<DashboardShell user={user} orgs={orgs}><p>b</p></DashboardShell>);

    expect(screen.getByRole("navigation", { name: "Drawer nav" })).toBeTruthy();
  });
});
