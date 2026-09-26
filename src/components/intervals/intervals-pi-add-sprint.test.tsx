// @vitest-environment jsdom
//
// COSMOS-160 — "I should have PI-1, and then under that I should add sprints."
//
// The only way to put a sprint in a PI was to create it at the top level and
// then reparent it with the card's "Move to PI" select — a two-step detour that
// made the PI feel like a label rather than a container. The PI block now has
// its own "Add sprint to <PI>" control, and the create it fires carries the
// PI's id as parentId so the sprint lands inside on the first try.
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

const INTERVALS = [
  { ...base, id: "pi2", number: 2, name: "PI 2", intervalKind: "PROGRAM_INCREMENT", parentId: null },
  { ...base, id: "pi1", number: 1, name: "PI 1", intervalKind: "PROGRAM_INCREMENT", parentId: null },
];

function installFetch() {
  const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    if (method === "GET") return { ok: true, json: async () => INTERVALS } as Response;
    return { ok: true, json: async () => ({ id: "new" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("IntervalsWorkspace — adding a sprint from the PI view (COSMOS-160)", () => {
  it("gives each PI its own add control, inside a group labelled by that PI", async () => {
    installFetch();
    render(<IntervalsWorkspace orgId="o1" projectId="p1" projectKey="ENG" />);

    await screen.findByText("PI 1");
    // Two PIs on screen → two add controls, each announced against its own PI
    // rather than as an ambiguous pair of "Add sprint" buttons.
    for (const name of ["PI 1", "PI 2"]) {
      const group = screen.getByRole("group", { name });
      expect(within(group).getByRole("button", { name: "Add sprint" })).toBeTruthy();
    }
  });

  it("POSTs the new sprint with the PI as its parent", async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    render(<IntervalsWorkspace orgId="o1" projectId="p1" projectKey="ENG" />);

    await screen.findByText("PI 1");
    const pi1 = screen.getByRole("group", { name: "PI 1" });
    await user.click(within(pi1).getByRole("button", { name: "Add sprint" }));

    // The dialog says which PI it is adding to, and does not offer a Kind —
    // only sprints nest under a PI.
    await screen.findByRole("heading", { name: "Add a sprint to PI 1" });
    expect(screen.queryByLabelText("Kind")).toBeNull();

    await user.type(screen.getByLabelText("Name"), "Sprint A");
    await user.type(screen.getByLabelText("Start date"), "2026-09-01");
    await user.type(screen.getByLabelText("End date"), "2026-09-14");
    await user.click(screen.getByRole("button", { name: "Create interval" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST");
      expect(post).toBeDefined();
      expect(post!.url.endsWith("/intervals")).toBe(true);
      expect(post!.body).toMatchObject({
        name: "Sprint A",
        intervalKind: "SPRINT",
        parentId: "pi1",
      });
    });
  });

  it("keeps the plain top-level create parent-less", async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    render(<IntervalsWorkspace orgId="o1" projectId="p1" projectKey="ENG" />);

    await screen.findByText("PI 1");
    await user.click(screen.getByRole("button", { name: /New interval/ }));
    await screen.findByRole("heading", { name: "Plan an interval" });

    await user.type(screen.getByLabelText("Name"), "Standalone");
    await user.type(screen.getByLabelText("Start date"), "2026-09-01");
    await user.type(screen.getByLabelText("End date"), "2026-09-14");
    await user.click(screen.getByRole("button", { name: "Create interval" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST");
      expect(post).toBeDefined();
      expect(post!.body).toMatchObject({ name: "Standalone", parentId: null });
    });
  });
});
