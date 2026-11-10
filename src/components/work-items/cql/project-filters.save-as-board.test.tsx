// @vitest-environment jsdom
//
// "How do I save a filter as a board?" — asked three times now, about a feature
// that has shipped twice.
//
// Both existing doors are on the Issues page: a toolbar button that acts on
// whatever query is in the bar, and an action inside the saved-filters
// DROPDOWN. Neither is where someone goes looking. The project has a tab
// literally called "Filters" which lists the saved filters shared with it —
// and that list offered no actions at all, just a name and an owner. A reader
// who wants to turn one of their filters into a board goes to the tab named
// after filters, finds his filters, and finds nothing he can do with them.
//
// So the action lives here too, pointing at the Issues deep link that already
// owns the dialog, its CQL validation and its project gating. It is absent —
// not present-and-refused — for someone who cannot create boards in this
// project, which is why the page derives that with canManageBoardsInProject
// rather than guessing from an org grant.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectFilters } from "./project-filters";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/filters",
  useSearchParams: () => new URLSearchParams(),
}));

const FILTERS = [
  { id: "f1", name: "My open bugs", description: "", ownerName: "Dana" },
  { id: "f2", name: "Blocked this sprint", description: "", ownerName: "Dana" },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn(() => Promise.resolve(FILTERS)),
}));

afterEach(cleanup);

function renderTab(canCreateBoard: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ProjectFilters
        orgId="11111111-1111-4111-8111-111111111111"
        orgSlug="acme"
        projectId="p1"
        projectKey="FSC"
        canCreateBoard={canCreateBoard}
      />
    </QueryClientProvider>,
  );
}

describe("the Filters tab can turn a filter into a board", () => {
  it("offers the action on each filter", async () => {
    renderTab(true);
    const links = await screen.findAllByRole("link", { name: /save .*as board/i });
    expect(links).toHaveLength(2);
  });

  it("carries the filter AND the request to open the dialog", async () => {
    // Both params matter: the filter id alone just runs it, and saveBoard alone
    // would open the dialog over whatever query happened to be in the bar.
    renderTab(true);
    const [first] = await screen.findAllByRole("link", { name: /save .*as board/i });
    const href = first.getAttribute("href") ?? "";
    expect(href).toContain("/acme/work-items?");
    expect(href).toContain("filter=f1");
    expect(href).toContain("saveBoard=1");
  });

  it("names the filter it acts on, so two rows are told apart", async () => {
    renderTab(true);
    expect(
      await screen.findByRole("link", { name: "Save as board: Blocked this sprint" }),
    ).toBeTruthy();
  });

  it("leads the accessible name with the VISIBLE text (WCAG 2.5.3)", async () => {
    // Speech input activates a control by its visible text, so "Save <name> as
    // board" — which reads better — would leave "click Save as board" matching
    // nothing. The axe gate cannot catch this: it runs wcag2a/wcag2aa, and
    // label-content-name-mismatch is a 2.1 rule.
    renderTab(true);
    const [first] = await screen.findAllByRole("link", { name: /save .*as board/i });
    expect(first.getAttribute("aria-label")).toMatch(/^Save as board\b/);
    expect(first.textContent).toContain("Save as board");
  });

  it("is absent for a viewer who cannot create boards here", async () => {
    renderTab(false);
    // Wait for the list itself, so "absent" is asserted against a RENDERED
    // list rather than being trivially true of a page that never loaded.
    expect(await screen.findByText("My open bugs")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /save .*as board/i })).toBeNull();
  });
});
