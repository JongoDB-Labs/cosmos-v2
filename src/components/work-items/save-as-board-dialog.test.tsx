// @vitest-environment jsdom
//
// "Save as board" must never create a board whose scope it does not yet know.
//
// `config: {}` is a board with no baseline, and `boardBaseline` reads that as
// "everything". With the query language on, the scope arrives asynchronously —
// a saved filter's CQL is fetched, then validated server-side — so there is a
// window where neither a query nor a legacy filter is in hand. Creating then
// yields a board showing every item in the project instead of the filter's,
// silently. Racing that was possible from the toolbar button; it is easy now
// that the Saved menu opens this dialog on one click.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/acme/issues",
  useParams: () => ({ orgSlug: "acme" }),
}));
vi.mock("@/lib/query/json-fetcher", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn() };
});

import { SaveAsBoardDialog } from "./save-as-board-dialog";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { CQL_VERSION, type CqlQuery } from "@/lib/query/ast";

const PROJECTS = [{ id: "p1", key: "APOLLO", name: "Apollo", archived: false }];

/** A query that says something, so "scope known" is not merely "scope empty". */
const QUERY: CqlQuery = {
  v: CQL_VERSION,
  where: {
    op: "cmp",
    field: { kind: "sys", id: "status" },
    cmp: "eq",
    value: { t: "str", v: "open" },
  },
};

function open(props: Partial<React.ComponentProps<typeof SaveAsBoardDialog>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SaveAsBoardDialog
        open
        onOpenChange={() => {}}
        orgId="o1"
        orgSlug="acme"
        filter={null}
        projects={PROJECTS}
        {...props}
      />
    </QueryClientProvider>,
  );
}

const createButton = () => screen.getByRole("button", { name: /create board/i });
const posts = () =>
  vi.mocked(jsonFetch).mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "POST");

beforeEach(() => {
  vi.mocked(jsonFetch).mockResolvedValue({ id: "b1", slug: "my-board" } as never);
});
afterEach(() => {
  cleanup();
  vi.mocked(jsonFetch).mockReset();
});

describe("SaveAsBoardDialog", () => {
  it("opens with the board name already filled in from the filter", () => {
    // Coming from a saved filter, its name is the obvious name for the board.
    open({ defaultName: "My open bugs", query: QUERY });
    expect(screen.getByLabelText(/board name/i)).toHaveValue("My open bugs");
  });

  describe("when the scope is not known yet", () => {
    // Neither a resolved query nor a legacy filter.
    const pending = { filter: null, query: undefined, defaultName: "Urgent" };

    it("will not create a board", () => {
      open(pending);
      expect(createButton()).toBeDisabled();
    });

    it("says why", () => {
      open(pending);
      expect(screen.getByRole("status")).toHaveTextContent(/which items this filter matches/i);
    });

    it("sends nothing even if the form is submitted anyway", async () => {
      open(pending);
      fireEvent.submit(screen.getByLabelText(/board name/i).closest("form")!);
      // NOT `waitFor(() => expect(posts()).toHaveLength(0))` — that assertion is
      // already true on the first tick, so it returns before a mutation fired
      // on submit could record anything, and passes however broken the guard
      // is. Give it real time to happen instead.
      await new Promise((r) => setTimeout(r, 20));
      expect(posts()).toHaveLength(0);
    });

    it("...and that same submit DOES send once the query has resolved", async () => {
      // Positive control for the case above: a submit that never reaches the
      // handler would make it pass no matter what the guard did.
      open({ ...pending, query: QUERY });
      fireEvent.submit(screen.getByLabelText(/board name/i).closest("form")!);
      await waitFor(() => expect(posts()).toHaveLength(1));
    });
  });

  it("...but DOES create one once the query has resolved", async () => {
    // Positive control: without this, the three cases above would pass against
    // a dialog that could never create a board at all.
    open({ defaultName: "My open bugs", query: QUERY });
    expect(createButton()).not.toBeDisabled();
    fireEvent.click(createButton());
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0];
    expect(url).toBe("/api/v1/orgs/o1/projects/p1/boards");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.name).toBe("My open bugs");
    expect(body.config.query).toBeTruthy();
  });

  it("is blocked by the caller's own reason, even when it holds a query", () => {
    // The Issues view knows things the dialog cannot — a restricted filter, a
    // query still validating, a saved filter still being fetched.
    open({ query: QUERY, defaultName: "X", unavailableReason: "Loading the filter…" });
    expect(createButton()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Loading the filter…");
  });

  it("creates from a legacy filter with no CQL query", async () => {
    // The query language off: `filter` carries the scope and `query` is absent.
    open({ filter: { priorities: ["HIGH"] }, defaultName: "High priority" });
    expect(createButton()).not.toBeDisabled();
    fireEvent.click(createButton());
    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = JSON.parse((posts()[0][1] as RequestInit).body as string);
    expect(body.config.savedFilter).toEqual({ priorities: ["HIGH"] });
  });
});
