// @vitest-environment jsdom
//
// BUG 635be41c on the Roadmap — the second surface that struck out delivered features and
// left dropped ones looking live. See the backlog spec of the same name for why
// `isWorkItemResolved` existed with a single call site.
//
// This card is the interesting one, because it renders TWO signals off what used to be one
// boolean: a green tick and a strikethrough. They mean different things and must diverge —
// the tick is DELIVERED, the strike is SETTLED. A cancelled feature must be struck WITHOUT
// being ticked, or the board claims work shipped that was abandoned.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/work-items/card-detail-sheet", () => ({ CardDetailSheet: () => null }));
vi.mock("@/components/boards/shared/board-query-bar", () => ({ BoardQueryBar: () => null }));

const BOARD = {
  id: "b1",
  columns: [
    { id: "c1", key: "todo", name: "To Do", sortOrder: 0, category: "TODO" },
    { id: "c2", key: "done", name: "Done", sortOrder: 1, category: "DONE" },
    { id: "c3", key: "cancelled", name: "Cancelled", sortOrder: 2, category: "CANCELLED" },
  ],
};

const feature = (id: string, title: string, columnKey: string, extra: Record<string, unknown> = {}) => ({
  id,
  ticketNumber: Number(id.replace(/\D/g, "")),
  title,
  columnKey,
  parentId: "e1",
  priority: "MEDIUM" as const,
  assigneeId: null,
  intervalId: null,
  sortOrder: Number(id.replace(/\D/g, "")),
  ...extra,
});

const ITEMS = [
  {
    id: "e1", ticketNumber: 1, title: "The epic", columnKey: "todo", priority: "MEDIUM",
    assigneeId: null, intervalId: null, sortOrder: 0,
    workItemType: { key: "EPIC", name: "Epic" },
  },
  feature("w2", "Delivered feature", "done"),
  feature("w3", "Dropped feature", "cancelled"),
  feature("w4", "Open feature", "todo"),
  // In a DONE lane but with no end date stamped. The tick used to read `!!completedAt`
  // alone, so this card would have been struck (via the lane) and NOT ticked — the two
  // signals disagreeing on one card. Both read the lane now.
  feature("w5", "Delivered, no end date", "done"),
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url === "/api/v1/me") return Promise.resolve({ id: "me", email: "me@x.com", displayName: "Me" });
    if (url.endsWith("/boards/b1")) return Promise.resolve(BOARD);
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/members")) return Promise.resolve([]);
    if (url.endsWith("/intervals")) return Promise.resolve([]);
    return Promise.resolve([]);
  }),
}));

import { RoadmapView } from "./roadmap-view";

const renderRoadmap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RoadmapView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
};

/** The title span carries the strikethrough. */
const struck = (title: string) => screen.getByText(title).className.includes("line-through");

/**
 * Is the card TICKED? The tick is an svg inside the bullet span, which is a sibling of the
 * title's wrapper — so walk up to the card button and look for the icon.
 */
const ticked = (title: string) => {
  const card = screen.getByText(title).closest("button");
  expect(card).not.toBeNull();
  return card!.querySelector("svg.lucide-check") !== null;
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RoadmapView — a settled feature is struck out", () => {
  it("strikes a DONE feature (the behaviour the report asked to match)", async () => {
    renderRoadmap();
    await screen.findByText("Delivered feature");
    expect(struck("Delivered feature")).toBe(true);
  });

  it("strikes a CANCELLED feature — the bug", async () => {
    renderRoadmap();
    await screen.findByText("Dropped feature");
    expect(struck("Dropped feature")).toBe(true);
  });

  it("CONTROL: leaves an open feature alone", async () => {
    renderRoadmap();
    await screen.findByText("Open feature");
    expect(struck("Open feature")).toBe(false);
  });
});

describe("RoadmapView — the tick still means DELIVERED, not merely settled", () => {
  it("does NOT tick a cancelled feature, though it strikes it", async () => {
    // The distinction the whole change rests on. If `resolved` had been used for both, the
    // board would show a green check against work that was abandoned.
    renderRoadmap();
    await screen.findByText("Dropped feature");
    expect(struck("Dropped feature")).toBe(true);
    expect(ticked("Dropped feature")).toBe(false);
  });

  it("ticks a delivered feature", async () => {
    renderRoadmap();
    await screen.findByText("Delivered feature");
    expect(ticked("Delivered feature")).toBe(true);
  });

  it("ticks an item in a DONE lane that has no end date stamped", async () => {
    // Previously `!!completedAt` alone, so the lane was ignored and tick/strike disagreed.
    renderRoadmap();
    await screen.findByText("Delivered, no end date");
    expect(ticked("Delivered, no end date")).toBe(true);
    expect(struck("Delivered, no end date")).toBe(true);
  });

  it("CONTROL: does not tick an open feature", async () => {
    renderRoadmap();
    await screen.findByText("Open feature");
    expect(ticked("Open feature")).toBe(false);
  });
});
