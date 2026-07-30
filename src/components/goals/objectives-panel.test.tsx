// @vitest-environment jsdom
/**
 * #51 — objectives are creatable on Goals / Objectives, and the two boards
 * showing them stay in step.
 *
 * The panel was deliberately read-only ("objectives are authored on the OKR
 * board"), which left projects without the optional OKR View board unable to
 * create an objective at all. Adding a button here is only half the job: the
 * two surfaces read different stores — this panel used React Query, the OKR
 * board a bare `fetch` into `useState` — so a create on one was invisible to
 * the other until a reload. Two boards, one record, two answers.
 *
 * So the load-bearing test renders BOTH surfaces in ONE QueryClientProvider and
 * asserts a create on the panel reaches the board. That is the assertion that
 * fails if either surface stops sharing the cache key, which no test of the
 * panel alone could catch.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ObjectivesPanel } from "./objectives-panel";
import { OkrBoard } from "@/components/okrs/okr-board";

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

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/goals",
  useRouter: () => ({ push: () => {} }),
}));

const INTERVALS = [
  { id: "int-1", name: "Sprint 1", goal: null },
  { id: "int-2", name: "Sprint 2", goal: null },
];

const EXISTING = {
  id: "o-1",
  title: "Existing objective",
  committed: true,
  progress: 40,
  intervalId: "int-1",
  status: "ACTIVE",
  keyResults: [],
};

let postBodies: Record<string, unknown>[] = [];
let objectives: unknown[] = [];

function mockFetch() {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST" && u.endsWith("/objectives")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      postBodies.push(body);
      const created = {
        ...EXISTING,
        id: "o-2",
        title: body.title,
        committed: body.committed,
        intervalId: body.intervalId ?? null,
        progress: 0,
      };
      objectives = [...objectives, created];
      return new Response(JSON.stringify(created), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/objectives")) {
      return new Response(JSON.stringify(objectives), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/intervals")) {
      return new Response(JSON.stringify(INTERVALS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function renderBoth() {
  /**
   * If you mutation-test the crosstalk case below, desync the board's key by
   * changing the FIRST part, e.g. `useOrgQueryKey("okr-objectives", projectId)`.
   *
   * Appending a segment — `useOrgQueryKey("objectives", projectId, "board")` —
   * does NOT desync anything and the test still passes, which reads like
   * vacuity but isn't: `invalidateQueries` matches by PREFIX, so invalidating
   * ["org",slug,"objectives",p] still invalidates
   * ["org",slug,"objectives",p,"board"]. That cost a confused pass here.
   */
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <div data-testid="panel">
        <ObjectivesPanel orgId="org-1" projectId="p-1" />
      </div>
      <div data-testid="board">
        <OkrBoard orgId="org-1" projectId="p-1" />
      </div>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  postBodies = [];
  objectives = [EXISTING];
  vi.stubGlobal("fetch", mockFetch());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ObjectivesPanel — creating objectives", () => {
  it("offers a create affordance and does not send the reader to another board", async () => {
    objectives = [];
    renderBoth();

    const panel = within(screen.getByTestId("panel"));
    expect(
      await panel.findByRole("button", { name: /new objective/i }),
    ).toBeTruthy();

    // The empty state used to read "They're created on the OKR View board".
    // With a button here, that instruction would be wrong.
    const empty = await panel.findByText(/no objectives yet/i);
    expect(empty.textContent).toMatch(/new objective/i);
    expect(empty.textContent).not.toMatch(/created on the OKR View board/i);
  });

  it("posts the title, interval and committed flag the release added", async () => {
    const user = userEvent.setup();
    renderBoth();

    const panel = within(screen.getByTestId("panel"));
    await user.click(await panel.findByRole("button", { name: /new objective/i }));
    await user.type(
      panel.getByPlaceholderText("Objective title..."),
      "Panel-made objective",
    );
    await user.selectOptions(panel.getByLabelText("Interval"), "int-2");
    await user.click(panel.getByLabelText(/uncommitted \(stretch\)/i));
    await user.click(panel.getByRole("button", { name: /^Add$/ }));

    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]).toMatchObject({
      title: "Panel-made objective",
      intervalId: "int-2",
      committed: false, // "Uncommitted (stretch)" ticked
    });
  });

  it("omits intervalId entirely when no interval is chosen", async () => {
    // "" is not a valid interval and the route rejects a foreign one, so the
    // field must be absent rather than empty.
    const user = userEvent.setup();
    renderBoth();

    const panel = within(screen.getByTestId("panel"));
    await user.click(await panel.findByRole("button", { name: /new objective/i }));
    await user.type(panel.getByPlaceholderText("Objective title..."), "No interval");
    await user.click(panel.getByRole("button", { name: /^Add$/ }));

    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]).not.toHaveProperty("intervalId");
  });
});

describe("crosstalk — one Objective record, two surfaces", () => {
  it("shows an objective created on the panel on the OKR board too", async () => {
    const user = userEvent.setup();
    renderBoth();

    const board = within(screen.getByTestId("board"));
    // Baseline: the board shows only the pre-existing objective.
    expect(await board.findByText("Existing objective")).toBeTruthy();
    expect(board.queryByText("Made on the Goals board")).toBeNull();

    const panel = within(screen.getByTestId("panel"));
    await user.click(await panel.findByRole("button", { name: /new objective/i }));
    await user.type(
      panel.getByPlaceholderText("Objective title..."),
      "Made on the Goals board",
    );
    await user.click(panel.getByRole("button", { name: /^Add$/ }));

    // The load-bearing assertion: it appears on the OTHER surface, with no
    // reload and nothing telling the board to refetch. Only a shared cache key
    // does this.
    expect(await board.findByText("Made on the Goals board")).toBeTruthy();
    // ...and on the panel that created it.
    expect(await panel.findByText("Made on the Goals board")).toBeTruthy();
  });
});
