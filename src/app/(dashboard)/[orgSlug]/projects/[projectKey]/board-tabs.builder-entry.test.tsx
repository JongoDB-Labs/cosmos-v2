// @vitest-environment jsdom
//
// The widget builder's way in.
//
// `grep -rn "/builder" src` used to return exactly one hit, and it was an
// unrelated store import: the board builder at
// `boards/[boardId]/builder/page.tsx` was reachable ONLY by typing the URL.
// Now that a DASHBOARD-family board actually RENDERS what the builder saves,
// the missing affordance is the whole remaining gap, so this pins it — present
// for someone who may manage boards, absent for someone who may not, and
// absent on a board type that could not draw the result anyway.
//
// WHICH SPEC CATCHES WHICH MUTATION (stated up front so neither assertion can
// rot into a false green — see memory: a-loose-assertion-is-a-false-green):
//   * delete the `canManageBoards &&` gate  -> "hides it from someone who may
//     not manage boards" fails (the item appears for a non-manager).
//   * make the item unconditional (drop the whole `if`, always push)
//                                           -> the same spec fails, AND
//     "offers nothing on a board type that cannot render widgets" fails.
//   * delete the item entirely              -> "offers Edit layout …" fails.
// The absent-side assertions are only meaningful because the present-side one
// proves the same probe (`getByRole("menuitem")`) can see the item when it IS
// there.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/PROJ/boards/health",
  useRouter: () => ({ push, refresh }),
}));

import { ProjectBoardTabs } from "./board-tabs";

const baseProps = {
  orgSlug: "acme",
  projectKey: "PROJ",
  orgId: "org1",
  projectId: "proj1",
  boards: [
    // A DASHBOARD board — the family (DASHBOARD/PORTFOLIO/PROGRAM) whose view
    // reads `Board.config.widgets`.
    { id: "b-dash", name: "Sprint Health", type: "DASHBOARD", slug: "health" },
    // A KANBAN board — nothing renders saved widgets there, so a one-click
    // path to the builder from it would lead to a layout no screen displays.
    { id: "b-kanban", name: "Sprint", type: "KANBAN", slug: "sprint" },
  ],
  enabledFeatures: [],
  canManageBoards: true,
  canCreateBoards: true,
  canSetProjectDefault: true,
};

afterEach(cleanup);
beforeEach(() => {
  push.mockClear();
  refresh.mockClear();
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200 }),
  ) as unknown as typeof fetch;
});

const kebab = (name: RegExp) => screen.getByRole("button", { name });
const menuLabels = () =>
  screen.queryAllByRole("menuitem").map((m) => m.textContent);

describe("the board builder's entry point", () => {
  it("offers Edit layout on a widget-capable board for someone who may manage boards", () => {
    render(<ProjectBoardTabs {...baseProps} />);
    fireEvent.click(kebab(/Tab actions for Sprint Health/));
    // The accessible name CONTAINS the visible text (WCAG 2.5.3): the row's
    // label IS its accessible name, and it names the board so a screen-reader
    // user hears which board they are about to restructure.
    expect(menuLabels()).toContain("Edit layout: Sprint Health");
  });

  it("navigates to the builder by board ID, not by slug", () => {
    // `builder/page.tsx` resolves slug-or-UUID now, but linking the id is what
    // makes the link independent of the slug — and the id is the value the
    // board page canonicalises AWAY from, so a slug-only link would have been
    // the one thing never exercised.
    render(<ProjectBoardTabs {...baseProps} />);
    fireEvent.click(kebab(/Tab actions for Sprint Health/));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Edit layout: Sprint Health" }),
    );
    expect(push).toHaveBeenCalledWith(
      "/acme/projects/PROJ/boards/b-dash/builder",
    );
  });

  it("hides it from someone who may NOT manage boards", () => {
    render(
      <ProjectBoardTabs
        {...baseProps}
        canManageBoards={false}
        canCreateBoards={false}
        canSetProjectDefault={false}
      />,
    );
    fireEvent.click(kebab(/Tab actions for Sprint Health/));
    const labels = menuLabels();
    // The menu really did open, so "not there" is about the item and not about
    // an unopened menu.
    expect(labels).toContain("Hide tab");
    expect(labels).not.toContain("Edit layout: Sprint Health");
    expect(labels.filter((l) => l?.includes("Edit layout"))).toEqual([]);
  });

  it("offers nothing on a board type that cannot render widgets", () => {
    render(<ProjectBoardTabs {...baseProps} />);
    fireEvent.click(kebab(/Tab actions for Sprint$/));
    const labels = menuLabels();
    // Manager rights are present (Rename board proves it), so the absence is
    // the board TYPE talking, not the permission.
    expect(labels).toContain("Rename board");
    expect(labels.filter((l) => l?.includes("Edit layout"))).toEqual([]);
  });

  it("offers nothing on a feature tab, which is not a board at all", () => {
    render(<ProjectBoardTabs {...baseProps} enabledFeatures={["okr"]} />);
    fireEvent.click(kebab(/Tab actions for OKRs/));
    expect(menuLabels().filter((l) => l?.includes("Edit layout"))).toEqual([]);
  });

  it("offers it on PORTFOLIO and PROGRAM too — same view, same reader", () => {
    render(
      <ProjectBoardTabs
        {...baseProps}
        boards={[
          { id: "b-pf", name: "Portfolio", type: "PORTFOLIO", slug: "pf" },
          { id: "b-pg", name: "Program", type: "PROGRAM", slug: "pg" },
        ]}
      />,
    );
    fireEvent.click(kebab(/Tab actions for Portfolio/));
    expect(menuLabels()).toContain("Edit layout: Portfolio");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    fireEvent.click(kebab(/Tab actions for Program/));
    expect(menuLabels()).toContain("Edit layout: Program");
  });

  it("tolerates a lower-cased board type from an older payload", () => {
    // `board-tabs.test.tsx` seeds `type: "kanban"`, and the column is an enum
    // so the real payload is upper case. A case-sensitive comparison would be
    // green on the enum and silently wrong on anything that round-trips the
    // value through a lower-casing layer.
    render(
      <ProjectBoardTabs
        {...baseProps}
        boards={[
          { id: "b-dash", name: "Sprint Health", type: "dashboard", slug: "health" },
        ]}
      />,
    );
    fireEvent.click(kebab(/Tab actions for Sprint Health/));
    expect(menuLabels()).toContain("Edit layout: Sprint Health");
  });
});
