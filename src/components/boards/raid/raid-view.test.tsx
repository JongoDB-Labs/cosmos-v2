// @vitest-environment jsdom
// COSMOS-80 — RAID log: items showed up "Unclassified" with no way to edit,
// drag-and-drop, or create them into a category. This locks the three pieces
// that make the log functional:
//   1. `categorize` / `retag` — the pure reclassify logic behind BOTH the
//      per-card "Categorize" menu (edit) and drag-and-drop.
//   2. The view actually buckets tagged items into their columns (so not
//      "everything Unclassified").
//   3. "New issue" from the RAID log seeds a category preset, so a new entry
//      defaults to a real column instead of Unclassified.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
}));

// Capture the props the RAID log hands the shared create button — that's the
// COSMOS-80 wiring (a category preset so new entries aren't Unclassified).
const createIssueProps = vi.fn();
vi.mock("@/components/boards/shared/create-issue-button", () => ({
  CreateIssueButton: (props: Record<string, unknown>) => {
    createIssueProps(props);
    return <button type="button">New issue</button>;
  },
}));

const item = (id: string, title: string, tags: string[]) => ({
  id,
  ticketNumber: Number(id.replace(/\D/g, "")) || 1,
  title,
  tags,
  columnKey: "todo",
  priority: "MEDIUM" as const,
  assigneeId: null,
});

const ITEMS = [
  item("i1", "A real risk", ["risk"]),
  item("i2", "A stray dependency", ["backend", "Dependency"]), // case-insensitive
  item("i3", "Loose item", ["backend"]), // no RAID tag → Unclassified
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/members")) return Promise.resolve([]);
    return Promise.resolve([]);
  }),
}));

import { RaidView, categorize, retag } from "./raid-view";

describe("categorize", () => {
  it("maps the first RAID tag (case-insensitive) to its column", () => {
    expect(categorize({ tags: ["risk"] })).toBe("risk");
    expect(categorize({ tags: ["backend", "Issue"] })).toBe("issue");
    expect(categorize({ tags: ["ASSUMPTION"] })).toBe("assumption");
  });

  it("returns null (Unclassified) when no tag is a RAID category", () => {
    expect(categorize({ tags: [] })).toBeNull();
    expect(categorize({ tags: ["backend", "frontend"] })).toBeNull();
  });
});

describe("retag", () => {
  it("swaps the RAID tag while preserving every other tag (edit + drag)", () => {
    expect(retag(["backend", "risk"], "issue")).toEqual(["backend", "issue"]);
    expect(retag(["backend"], "risk")).toEqual(["backend", "risk"]);
  });

  it("strips ALL RAID tags case-insensitively when clearing", () => {
    expect(retag(["Risk", "assumption", "keep"], null)).toEqual(["keep"]);
  });
});

const renderRaid = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RaidView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
};

describe("RaidView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("buckets tagged items into their columns, not all Unclassified", async () => {
    renderRaid();
    await screen.findByText("A real risk");

    const risks = screen.getByTestId("raid-col-risk");
    const deps = screen.getByTestId("raid-col-dependency");
    const unclassified = screen.getByTestId("raid-col-none");

    expect(within(risks).getByText("A real risk")).toBeInTheDocument();
    expect(within(deps).getByText("A stray dependency")).toBeInTheDocument();
    expect(within(unclassified).getByText("Loose item")).toBeInTheDocument();

    // The reported symptom's negation: a tagged item is NOT dumped in Unclassified.
    expect(within(unclassified).queryByText("A real risk")).toBeNull();
  });

  it("seeds a RAID category preset on the create dialog (COSMOS-80)", async () => {
    renderRaid();
    await screen.findByText("A real risk");

    expect(createIssueProps).toHaveBeenCalled();
    const props = createIssueProps.mock.calls.at(-1)![0];
    expect(props.categoryPreset.defaultValue).toBe("risk");
    expect(props.categoryPreset.options.map((o: { value: string }) => o.value)).toEqual(
      ["risk", "assumption", "issue", "dependency"],
    );
  });
});
