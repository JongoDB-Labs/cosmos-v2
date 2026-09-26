// @vitest-environment jsdom
//
// COSMOS-160 — "my view of assignable tickets should be by default narrowed
// down into what I've added to that higher level task (in this case, PI-1)".
//
// The picker listed every issue in the project regardless of which PI the
// sprint sat in, so staging work on a PI bought a planner nothing: the sprint's
// list was exactly as long as before. It now starts narrowed to the parent PI
// and can be widened back — a default, not a rule.
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

vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { AddIssuesDialog } from "./add-issues-dialog";
import type { AssignableScope } from "@/lib/intervals/assignable-scope";

// Sprint 1 and Sprint 2 live in PI 1; Sprint 3 lives in PI 2.
const ITEMS = [
  { id: "w1", title: "Staged on the PI", ticketNumber: 1, intervalId: "pi1" },
  { id: "w2", title: "In a sibling sprint", ticketNumber: 2, intervalId: "s2" },
  { id: "w3", title: "In another PI", ticketNumber: 3, intervalId: "s3" },
  { id: "w4", title: "Loose in the backlog", ticketNumber: 4, intervalId: null },
];

const SCOPE: AssignableScope = {
  piId: "pi1",
  piName: "PI 1",
  intervalIds: ["pi1", "s1", "s2"],
};

function installFetch() {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    void init;
    void url;
    return { ok: true, status: 200, json: async () => ITEMS } as Response;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function renderDialog(scope: AssignableScope | null) {
  return render(
    <AddIssuesDialog
      orgId="o1"
      projectId="p1"
      projectKey="P1"
      interval={{ id: "s1", name: "Sprint 1" }}
      open
      onOpenChange={() => {}}
      onAdded={() => {}}
      intervalNames={{ pi1: "PI 1", s2: "Sprint 2", s3: "Sprint 3" }}
      scope={scope}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddIssuesDialog — PI scoping", () => {
  it("defaults to the parent PI's items, hiding other PIs and the backlog", async () => {
    installFetch();
    renderDialog(SCOPE);

    await screen.findByText("Staged on the PI");
    expect(screen.getByText("In a sibling sprint")).toBeTruthy();
    expect(screen.queryByText("In another PI")).toBeNull();
    expect(screen.queryByText("Loose in the backlog")).toBeNull();
  });

  it("widens back to the whole project when the narrowing is turned off", async () => {
    const user = userEvent.setup();
    installFetch();
    renderDialog(SCOPE);

    await screen.findByText("Staged on the PI");
    const only = screen.getByRole("checkbox", { name: /Only issues in PI 1/ });
    expect((only as HTMLInputElement).checked).toBe(true);

    await user.click(only);

    await waitFor(() => expect(screen.getByText("In another PI")).toBeTruthy());
    expect(screen.getByText("Loose in the backlog")).toBeTruthy();
  });

  it("lists the whole project when nothing narrows it (no parent PI)", async () => {
    installFetch();
    renderDialog(null);

    await screen.findByText("In another PI");
    expect(screen.getByText("Loose in the backlog")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Only issues in/ })).toBeNull();
  });
});
