// @vitest-environment jsdom
/**
 * #52 — the link pickers must offer the project's CONFIGURED work-item type
 * first, and must still list the others.
 *
 * `link-type-default.test.ts` covers the pure resolver. This covers the wiring,
 * which is the part that has failed before in this codebase: a correct helper
 * that some call site doesn't use (see #506 — `branchLabel` was right for three
 * releases while the create dialogs ignored it). So this drives the real dialogs
 * against a real project payload and asserts the rendered ORDER.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeyResultLinksDialog } from "./key-result-links-dialog";
import { ObjectiveLinksDialog } from "./objective-links-dialog";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/okr-view",
  useParams: () => ({ projectKey: "FSC" }),
  useRouter: () => ({ push: () => {} }),
}));

const TYPES = [
  { id: "t-story", key: "software.story", name: "Story", sortOrder: 1 },
  { id: "t-epic", key: "software.epic", name: "Epic", sortOrder: 2 },
  // Custom, BARE key — the shape that has broken key-building resolution.
  { id: "t-feature", key: "feature", name: "Feature", sortOrder: 3 },
];

// Deliberately listed Stories FIRST, so passing requires real reordering rather
// than the source order happening to be right.
const ITEMS = [
  { id: "w1", title: "A story", ticketNumber: 1, completedAt: null, workItemTypeId: "t-story" },
  { id: "w2", title: "An epic", ticketNumber: 2, completedAt: null, workItemTypeId: "t-epic" },
  { id: "w3", title: "A feature", ticketNumber: 3, completedAt: null, workItemTypeId: "t-feature" },
];

let projectPayload: Record<string, unknown> = {};

function mockFetch() {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (u.endsWith("/work-item-types")) return json(TYPES);
    if (u.endsWith("/work-items")) return json(ITEMS);
    if (u.includes("/links")) return json([]);
    // the project GET — no trailing segment
    return json(projectPayload);
  });
}

beforeEach(() => {
  projectPayload = { krLinkTypeId: null, objectiveLinkTypeId: null };
  vi.stubGlobal("fetch", mockFetch());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** The ticket keys in rendered order, e.g. ["FSC-3","FSC-1","FSC-2"]. */
async function renderedOrder() {
  await waitFor(() => expect(screen.getByText("A feature")).toBeTruthy());
  const dialog = within(screen.getByRole("dialog"));
  return dialog
    .getAllByText(/^FSC-\d+$/)
    .map((el) => el.textContent?.trim() ?? "");
}

describe("KR link picker ordering", () => {
  it("puts Feature first by default, and still lists the other types", async () => {
    wrap(
      <KeyResultLinksDialog
        orgId="o1"
        projectId="p1"
        keyResultId="kr1"
        keyResultTitle="KR"
        linkedItems={[]}
        open
        onOpenChange={() => {}}
        onChanged={() => {}}
      />,
    );
    const order = await renderedOrder();
    expect(order[0]).toBe("FSC-3"); // the Feature
    // Ordering, not filtering — an org mid-transition keeps its Story links.
    expect(order).toHaveLength(3);
    expect(order).toContain("FSC-1");
    expect(order).toContain("FSC-2");
  });

  it("honours a configured type over the Feature default", async () => {
    projectPayload = { krLinkTypeId: "t-epic", objectiveLinkTypeId: null };
    wrap(
      <KeyResultLinksDialog
        orgId="o1"
        projectId="p1"
        keyResultId="kr1"
        keyResultTitle="KR"
        linkedItems={[]}
        open
        onOpenChange={() => {}}
        onChanged={() => {}}
      />,
    );
    const order = await renderedOrder();
    expect(order[0]).toBe("FSC-2"); // the Epic
  });

  it("names the preferred type in the dialog, so the behaviour is visible", async () => {
    wrap(
      <KeyResultLinksDialog
        orgId="o1"
        projectId="p1"
        keyResultId="kr1"
        keyResultTitle="KR"
        linkedItems={[]}
        open
        onOpenChange={() => {}}
        onChanged={() => {}}
      />,
    );
    expect(
      await screen.findByText(/Features are listed first; any ticket can still be linked/i),
    ).toBeTruthy();
  });
});

describe("Objective link picker ordering", () => {
  it("puts Feature first by default", async () => {
    wrap(
      <ObjectiveLinksDialog
        orgId="o1"
        projectId="p1"
        objectiveId="ob1"
        objectiveTitle="Obj"
        open
        onOpenChange={() => {}}
        onChanged={() => {}}
      />,
    );
    const order = await renderedOrder();
    expect(order[0]).toBe("FSC-3");
    expect(order).toHaveLength(3);
  });

  it("honours its OWN setting, independently of the KR one", async () => {
    // The two defaults are separate columns; a project may map KRs to Features
    // and objectives to Epics.
    projectPayload = { krLinkTypeId: "t-feature", objectiveLinkTypeId: "t-story" };
    wrap(
      <ObjectiveLinksDialog
        orgId="o1"
        projectId="p1"
        objectiveId="ob1"
        objectiveTitle="Obj"
        open
        onOpenChange={() => {}}
        onChanged={() => {}}
      />,
    );
    const order = await renderedOrder();
    expect(order[0]).toBe("FSC-1"); // the Story
  });
});
