// @vitest-environment jsdom
// A refused move says why. The server names what blocks putting a sprint in a
// Program Increment; the workspace threw a plain Error on any failed response,
// and notifyError shows its fixed fallback for anything that isn't a
// FetchError, so the user read "Couldn't move the sprint..." and nothing more.
// Only the toast is stubbed: the real notifyError decides what it says.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
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

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), warning: vi.fn(), message: vi.fn() }),
}));
vi.mock("@/lib/telemetry/server", () => ({ serverReportError: vi.fn() }));
vi.mock("@/components/providers/permissions-provider", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    usePermissions: () => ({ orgId: "o1", orgSlug: "acme", role: "ADMIN", permissions: 0n, can: () => true }),
  };
});
vi.mock("@/hooks/use-project-statuses", () => ({ useProjectStatuses: () => [] }));
vi.mock("./capacity-dialog", () => ({ CapacityDialog: () => null }));
vi.mock("./add-work-items-dialog", () => ({ AddWorkItemsDialog: () => null }));
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
const INTERVALS = [
  { ...base, id: "s4", number: 4, name: "Sprint 4", intervalKind: "SPRINT", parentId: null },
  { ...base, id: "pi1", number: 1, name: "PI 1", intervalKind: "PROGRAM_INCREMENT", parentId: null },
];

const REASON = "Sprint 4 ends after PI 1 does. Move its dates inside the PI first.";

/** GET lists the intervals; the PUT that moves the sprint answers `refusal`. */
function installFetch(refusal: () => Response) {
  const puts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return Response.json(INTERVALS);
      puts.push(JSON.parse(String(init?.body)));
      return refusal();
    }),
  );
  return puts;
}

async function moveSprintIntoPI() {
  const user = userEvent.setup();
  render(<IntervalsWorkspace orgId="o1" projectId="p1" projectKey="P1" />);
  await screen.findByText("Sprint 4");
  await user.click(screen.getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name: "PI 1" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("IntervalsWorkspace — a refused move into a Program Increment", () => {
  it("toasts the server's reason", async () => {
    const puts = installFetch(() =>
      Response.json(
        { type: "/problems/conflict", title: "Conflict", status: 409, code: "conflict", detail: REASON, error: REASON },
        { status: 409, headers: { "Content-Type": "application/problem+json" } },
      ),
    );
    await moveSprintIntoPI();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(puts).toEqual([{ parentId: "pi1" }]);
    expect(toastError).toHaveBeenCalledWith(REASON);
  });

  it("keeps its own sentence when the server gives no reason", async () => {
    installFetch(() => new Response("<html><body>Bad Gateway</body></html>", { status: 502 }));
    await moveSprintIntoPI();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledWith("Couldn't move the sprint to that Program Increment.");
  });
});
