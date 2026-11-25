// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describeRefreshError } from "@/components/boards/shared/refresh-error-kit";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

vi.mock("@/components/providers/permissions-provider", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  usePermissions: () => ({ orgId: "o1", orgSlug: "acme", role: "ADMIN", permissions: 0n, can: () => true }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/P1/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ orgSlug: "acme" }),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/hooks/use-work-item-realtime", () => ({ useWorkItemRealtime: () => {} }));
const toasts = vi.hoisted(() => ({ warning: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", async (orig) => {
  const real = (await orig()) as { toast: (...a: unknown[]) => unknown };
  return { ...(real as object), toast: Object.assign((...a: unknown[]) => real.toast(...a), real.toast, toasts) };
});

// The ceremony's own panels are not under test; the board's load handling is.
vi.mock("@/hooks/use-realtime-events", () => ({ useRealtimeEvents: () => {} }));
vi.mock("@/hooks/use-project-teams", () => ({ useProjectTeams: () => ({ data: [] }) }));
vi.mock("./ceremony-summary", () => ({ CeremonySummary: () => <div>Ceremony summary</div> }));
vi.mock("./item-lists", () => ({ ShippedList: () => null, CarriedList: () => null }));
vi.mock("./retro-columns", () => ({ RetroColumns: () => null }));
vi.mock("./action-items", () => ({ ActionItems: () => null }));
vi.mock("./capacity-panel", () => ({ CapacityPanel: () => null }));

import { CeremonyBoard } from "./ceremony-board";
import { REFRESH_FAILED_MESSAGE } from "@/components/boards/shared/use-refresh-failed-notice";

const sprint = (id: string, number: number, status: "ACTIVE" | "COMPLETED") => ({
  id, number, name: `Sprint ${number}`, status, intervalKind: "SPRINT",
  startDate: "2026-10-01T00:00:00.000Z", endDate: "2026-10-14T00:00:00.000Z",
});
const SPRINTS = [sprint("s1", 1, "ACTIVE"), sprint("s2", 2, "COMPLETED")];
const payload = (id: string) => ({
  sprint: { ...SPRINTS.find((s) => s.id === id)!, goal: "" },
  increment: null,
  board: { id: "b1", name: "Review", type: "SPRINT_REVIEW", config: null },
  columns: [],
  metrics: {},
  shipped: [],
  carried: { kind: "live", items: [] },
  nextSprint: { name: "Next", startDate: "2026-10-15", endDate: "2026-10-28", planned: false },
  ceremony: null,
});

function respond(u: string): unknown {
  if (u.endsWith("/intervals")) return SPRINTS;
  const m = u.match(/\/intervals\/([^/]+)\/ceremony/);
  if (m) return payload(m[1]);
  return [];
}

const view = () => (
  <CeremonyBoard orgId="o1" projectId="p1" projectKey="P1" boardId="b1" kind="REVIEW" viewerUserId="u1" />
);

describeRefreshError({
  name: "CeremonyBoard",
  view,
  content: "Ceremony summary",
  reads: {
    intervals: (u) => u.endsWith("/intervals"),
    ceremony: (u) => u.includes("/ceremony?"),
  },
  respond,
  toasts,
});

describe("CeremonyBoard: sprints and pickers", () => {
  const server = { intervals: 200, s1: 200, sprints: SPRINTS as unknown[] };
  beforeEach(() => {
    server.intervals = 200;
    server.s1 = 200;
    server.sprints = SPRINTS;
    toasts.warning.mockClear();
    toasts.dismiss.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        const status = u.endsWith("/intervals") ? server.intervals : u.includes("/intervals/s1/ceremony") ? server.s1 : 200;
        if (status !== 200) return new Response(JSON.stringify({ error: "nope" }), { status });
        const body = u.endsWith("/intervals") ? server.sprints : respond(u);
        return new Response(JSON.stringify({ data: body }), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  function renderBoard() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}>{view()}</QueryClientProvider>);
    return qc;
  }
  const tryAgain = () => screen.queryByRole("button", { name: "Try again" });

  it("a sprint list that fails to load is a LoadError, not \"No sprints yet\"", async () => {
    server.intervals = 500;
    renderBoard();
    await vi.waitFor(() => expect(tryAgain()).not.toBeNull(), { timeout: 5000 });
    expect(screen.queryByText("No sprints yet")).toBeNull();
  });

  it("a ceremony payload that fails for a valid sprint is a LoadError", async () => {
    server.s1 = 500;
    renderBoard();
    await vi.waitFor(() => expect(tryAgain()).not.toBeNull(), { timeout: 5000 });
    expect(screen.getByText("Could not load this ceremony.")).toBeTruthy();
  });

  it("a project with no sprints is still \"No sprints yet\"", async () => {
    server.sprints = [];
    renderBoard();
    expect(await screen.findByText("No sprints yet", {}, { timeout: 5000 })).toBeTruthy();
    expect(tryAgain()).toBeNull();
  });

  it("switching from a sprint whose refresh failed to a cached one dismisses the notice", async () => {
    const qc = renderBoard();
    await screen.findByText("Ceremony summary", {}, { timeout: 5000 });
    // The skeleton replaces the picker while a sprint loads, so look it up each time.
    const picker = () => screen.getByLabelText("Sprint");
    // Visit sprint 2 so it is cached, then come back to sprint 1.
    fireEvent.change(picker(), { target: { value: "s2" } });
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("/intervals/s2/ceremony"))).toBe(true));
    await screen.findByText("Ceremony summary");
    fireEvent.change(picker(), { target: { value: "s1" } });
    await vi.waitFor(() => expect((picker() as HTMLSelectElement).value).toBe("s1"));

    server.s1 = 500;
    await act(() => qc.invalidateQueries({ queryKey: ["org", "acme", "ceremony", "b1", "s1"] }));
    await vi.waitFor(() =>
      expect(toasts.warning).toHaveBeenCalledWith(REFRESH_FAILED_MESSAGE, expect.anything()),
    );
    expect(screen.getByText("Ceremony summary")).toBeTruthy();

    fireEvent.change(picker(), { target: { value: "s2" } });
    await vi.waitFor(() => expect(toasts.dismiss).toHaveBeenCalled());
    expect(toasts.warning).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Ceremony summary")).toBeTruthy();
  });
});
