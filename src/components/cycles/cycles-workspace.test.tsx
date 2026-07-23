// @vitest-environment jsdom
// COSMOS-138 — sprint planning/reviews, Phase 2. Acceptance criterion:
// "Sprints can be edited or deleted after creation without requiring them to be
// started first." A brand-new sprint is PLANNED (never activated). This locks
// that a PLANNED cycle exposes BOTH the edit and delete affordances, and that
// exercising them hits PUT / DELETE — so a regression that gated either action
// behind "must start (ACTIVE) first" would fail here.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// --- base-ui needs these in jsdom (see memory: testing-base-ui-in-jsdom) ---
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

// Grant every permission, but keep the real Permission enum the component reads.
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
// The child dialogs pull in their own data fetching; stub them out — this test
// is only about the PLANNED cycle's edit/delete affordances on the card.
vi.mock("./capacity-dialog", () => ({ CapacityDialog: () => null }));
vi.mock("./add-issues-dialog", () => ({ AddIssuesDialog: () => null }));

import { CyclesWorkspace } from "./cycles-workspace";

const PLANNED_CYCLE = {
  id: "cyc-1",
  number: 1,
  name: "Sprint 1",
  goal: "Ship the thing",
  startDate: "2026-08-01T00:00:00.000Z",
  endDate: "2026-08-14T00:00:00.000Z",
  status: "PLANNED" as const,
  cycleKind: "SPRINT",
  parentId: null,
  report: null,
  _count: { workItems: 0 },
};

/** fetch stub: GET lists the planned cycle; PUT/DELETE echo success. */
function installFetch() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    if (method === "GET") {
      return { ok: true, json: async () => [PLANNED_CYCLE] } as Response;
    }
    if (method === "DELETE") {
      return { ok: true, status: 204 } as Response;
    }
    // PUT
    return { ok: true, json: async () => ({ ...PLANNED_CYCLE }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("CyclesWorkspace — a not-started sprint can be edited or deleted (COSMOS-138)", () => {
  it("renders Edit and Delete affordances on a PLANNED (never-started) sprint", async () => {
    installFetch();
    render(<CyclesWorkspace orgId="o1" projectId="p1" projectKey="ENG" />);

    // The card renders once the cycles GET resolves.
    await screen.findByText("Sprint 1");
    // AC: both actions are available WITHOUT starting the sprint first.
    expect(screen.getByRole("button", { name: "Edit cycle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete cycle" })).toBeInTheDocument();
  });

  it("deletes a PLANNED sprint via DELETE — no activation required", async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    render(<CyclesWorkspace orgId="o1" projectId="p1" projectKey="ENG" />);

    await screen.findByText("Sprint 1");
    await user.click(screen.getByRole("button", { name: "Delete cycle" }));
    // Confirm in the dialog.
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.url.endsWith("/cycles/cyc-1")),
      ).toBe(true),
    );
    // No cycle was ever activated to make the delete possible.
    expect(
      calls.some(
        (c) =>
          c.method === "PUT" &&
          (c.body as { status?: string } | null)?.status === "ACTIVE",
      ),
    ).toBe(false);
  });

  it("edits a PLANNED sprint via PUT — no activation required", async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    render(<CyclesWorkspace orgId="o1" projectId="p1" projectKey="ENG" />);

    await screen.findByText("Sprint 1");
    await user.click(screen.getByRole("button", { name: "Edit cycle" }));

    // Dialog opens pre-filled for editing.
    const nameInput = await screen.findByLabelText("Name");
    expect(nameInput).toHaveValue("Sprint 1");
    await user.clear(nameInput);
    await user.type(nameInput, "Sprint 1 — renamed");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === "PUT" && c.url.endsWith("/cycles/cyc-1"),
      );
      expect(put).toBeTruthy();
      expect((put!.body as { name: string }).name).toBe("Sprint 1 — renamed");
    });
    // The edit did not depend on the sprint being ACTIVE.
    expect(
      calls.some(
        (c) =>
          c.method === "PUT" &&
          (c.body as { status?: string } | null)?.status === "ACTIVE",
      ),
    ).toBe(false);
  });
});

// ── COSMOS-139, Phase 3 — the sprint-review step renders on Complete ──────────
// An ACTIVE sprint's "Complete" opens a review step FIRST (before finalize),
// showing retrospective tiles derived from the cycle's items via
// computeSprintReview. This locks that the step renders with real metrics — a
// regression that dropped the review step (or its wiring to the compute) fails
// here. Dates are in the past so elapsed time is fully clamped and the figures
// are deterministic regardless of when CI runs.
const ACTIVE_SPRINT = {
  id: "cyc-1",
  number: 2,
  name: "Sprint 2",
  goal: "Deliver",
  startDate: "2026-07-01T00:00:00.000Z",
  endDate: "2026-07-11T00:00:00.000Z", // plannedDays = 10, fully elapsed
  status: "ACTIVE" as const,
  cycleKind: "SPRINT",
  parentId: null,
  report: null,
  _count: { workItems: 3 },
};

// 3 items, 2 done; points 5 + 3 done of 5 + 3 + 2 committed → 8/10 pts = 80%.
const REVIEW_ITEMS = [
  { storyPoints: 5, columnKey: "done" },
  { storyPoints: 3, columnKey: "done" },
  { storyPoints: 2, columnKey: "todo" },
];

/** fetch stub: list GET returns the ACTIVE sprint; the detail GET (loadReview)
 *  returns its work items so computeSprintReview has real input. */
function installFetchActive() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/cycles/cyc-1")) {
      return { ok: true, json: async () => ({ workItems: REVIEW_ITEMS }) } as Response;
    }
    if (method === "GET" && url.endsWith("/cycles")) {
      return { ok: true, json: async () => [ACTIVE_SPRINT] } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

describe("CyclesWorkspace — sprint review step on completion (COSMOS-139)", () => {
  it("shows retrospective tiles (efficiency, burn rate, pacing) when completing an ACTIVE sprint", async () => {
    installFetchActive();
    const user = userEvent.setup();
    render(<CyclesWorkspace orgId="o1" projectId="p1" projectKey="ENG" />);

    await screen.findByText("Sprint 2");
    // Complete opens the review step FIRST (not straight to finalize).
    await user.click(screen.getByRole("button", { name: "Complete" }));

    // The three retrospective tiles render, derived from the items above.
    expect(await screen.findByText("Efficiency")).toBeInTheDocument();
    expect(screen.getByText("Burn rate")).toBeInTheDocument();
    expect(screen.getByText("Pacing")).toBeInTheDocument();
    // 8 of 10 committed points completed → 80%.
    expect(screen.getByText("80%")).toBeInTheDocument();
    // Only 0.8× the ideal burndown by now → behind.
    expect(screen.getByText("behind")).toBeInTheDocument();
    // Advancing to finalize is a separate step (review is shown before it).
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });
});
