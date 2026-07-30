// @vitest-environment jsdom
//
// Intervals read top-down, and a Program Increment can be collapsed.
//
// The list was newest-first because the API returns `orderBy: { number: "desc" }`
// and the UI applied no ordering of its own — Sprint 5 sat above Sprint 1, and a
// PI's sprints read backwards. Ordering now happens in the UI (buildIntervalTree)
// so the five other consumers of that endpoint keep the order they expect.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
for (const m of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!Element.prototype[m]) {
    // @ts-expect-error — no-op pointer-capture stubs for jsdom
    Element.prototype[m] = () => {};
  }
}

vi.mock("@/components/providers/permissions-provider", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    usePermissions: () => ({
      orgId: "o1",
      orgSlug: "acme",
      role: "ADMIN",
      permissions: 0n,
      can: () => true,
    }),
  };
});
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("./capacity-dialog", () => ({ CapacityDialog: () => null }));
vi.mock("./add-issues-dialog", () => ({ AddIssuesDialog: () => null }));
vi.mock("./start-sprint-dialog", () => ({ StartSprintDialog: () => null }));

import { IntervalsWorkspace } from "./intervals-workspace";

const base = {
  goal: null,
  startDate: "2026-08-01T00:00:00.000Z",
  endDate: "2026-08-14T00:00:00.000Z",
  status: "PLANNED" as const,
  report: null,
  _count: { workItems: 0 },
};

// Deliberately supplied newest-first, exactly as the API returns them.
const INTERVALS = [
  { ...base, id: "s3", number: 3, name: "Sprint 3", intervalKind: "SPRINT", parentId: "pi1" },
  { ...base, id: "s2", number: 2, name: "Sprint 2", intervalKind: "SPRINT", parentId: "pi1" },
  { ...base, id: "s1", number: 1, name: "Sprint 1", intervalKind: "SPRINT", parentId: "pi1" },
  { ...base, id: "pi1", number: 1, name: "PI 1", intervalKind: "PROGRAM_INCREMENT", parentId: null },
];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return { ok: true, json: async () => INTERVALS } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }),
  );
}

function renderWorkspace() {
  return render(
    <IntervalsWorkspace orgId="o1" projectId="p1" projectKey="P1" />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("IntervalsWorkspace — PI grouping", () => {
  it("lists a PI's sprints top-down even though the API returns them newest-first", async () => {
    installFetch();
    renderWorkspace();

    await screen.findByText("Sprint 1");
    const order = screen
      .getAllByText(/^Sprint [123]$/)
      .map((el) => el.textContent);
    expect(order).toEqual(["Sprint 1", "Sprint 2", "Sprint 3"]);
  });

  it("collapses a PI to hide its sprints, and expands again", async () => {
    const user = userEvent.setup();
    installFetch();
    renderWorkspace();

    await screen.findByText("Sprint 1");

    const collapse = screen.getByRole("button", { name: /Collapse PI 1 \(3 sprints\)/ });
    expect(collapse).toHaveAttribute("aria-expanded", "true");

    await user.click(collapse);

    await waitFor(() => expect(screen.queryByText("Sprint 1")).toBeNull());
    expect(screen.getByText("3 sprints hidden")).toBeTruthy();

    const expand = screen.getByRole("button", { name: /Expand PI 1 \(3 sprints\)/ });
    expect(expand).toHaveAttribute("aria-expanded", "false");

    await user.click(expand);
    await waitFor(() => expect(screen.getByText("Sprint 1")).toBeTruthy());
  });

  it("names the PI in the control so several are distinguishable", async () => {
    // "Collapse" alone would be ambiguous with more than one PI on screen, and
    // is what a screen-reader user hears.
    installFetch();
    renderWorkspace();
    await screen.findByText("Sprint 1");
    expect(screen.getByRole("button", { name: /PI 1/ })).toBeTruthy();
  });
});
