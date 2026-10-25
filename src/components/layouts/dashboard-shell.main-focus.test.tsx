// @vitest-environment jsdom
//
// The page scroll container must be reachable by keyboard: a long page with
// nothing focusable in view could not be scrolled at all (axe scrollable-region-focusable).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

const { nav } = vi.hoisted(() => ({ nav: { pathname: "/acme" } }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));
vi.mock("@/lib/hooks/use-media-query", () => ({ useMediaQuery: () => false }));
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

describe("DashboardShell — the main scroll region", () => {
  it("is in the tab order, so the keyboard can scroll it", () => {
    render(<DashboardShell user={user} orgs={orgs}><p>long page</p></DashboardShell>);
    const main = document.getElementById("main")!;
    expect(main.tagName).toBe("MAIN");
    expect(main.tabIndex).toBe(0);
    expect(main.getAttribute("tabindex")).toBe("0");
  });

  it("is where Skip to content lands", () => {
    render(<DashboardShell user={user} orgs={orgs}><p>x</p></DashboardShell>);
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main");
  });

  it("does not take focus by itself, on load or on navigation", () => {
    const { rerender } = render(<DashboardShell user={user} orgs={orgs}><p>a</p></DashboardShell>);
    expect(document.activeElement).not.toBe(document.getElementById("main"));
    nav.pathname = "/acme/issues";
    rerender(<DashboardShell user={user} orgs={orgs}><p>b</p></DashboardShell>);
    expect(document.activeElement).not.toBe(document.getElementById("main"));
  });
});
