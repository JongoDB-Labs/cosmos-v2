// @vitest-environment jsdom
/**
 * What the OKR card shows for states the server now reports truthfully: a
 * cancelled objective (its health used to read "Behind" once past due), a
 * dependency that was cancelled, and a 0% bar whose track used to be the card's
 * own colour, so it drew nothing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ObjectiveCard } from "./objective-card";
import type { Objective, ObjectiveDependsOn } from "@/types/models";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/P/okrs",
  useParams: () => ({ projectKey: "P" }),
  useRouter: () => ({ push: () => {} }),
}));

const kr = {
  id: "kr1",
  objectiveId: "o1",
  title: "Signups",
  startValue: 0,
  currentValue: 0,
  targetValue: 100,
  unit: "",
  lowerIsBetter: false,
  status: "IN_PROGRESS" as const,
  sortOrder: 0,
  description: null,
  ownerId: null,
  confidence: null,
  rag: null,
  createdAt: "",
  updatedAt: "",
};

function objective(over: Partial<Objective>): Objective {
  return {
    id: "o1",
    orgId: "org",
    projectId: "p1",
    title: "Called off",
    description: null,
    ownerId: null,
    period: null,
    status: "ACTIVE",
    progress: 0,
    sortOrder: 0,
    parentId: null,
    createdAt: "",
    updatedAt: "",
    keyResults: [],
    ...over,
  } as Objective;
}

const dependency = (over: Partial<ObjectiveDependsOn>): ObjectiveDependsOn => ({
  id: "d1",
  title: "Old plan",
  projectId: "p1",
  status: "ACTIVE",
  targetDate: null,
  progress: 0,
  health: "on_track",
  overdue: false,
  ...over,
});

function renderCard(o: Objective) {
  // A key result row's dialogs read through React Query.
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ObjectiveCard
        objective={o}
        onEdit={() => {}}
        onLinkItems={() => {}}
        onDelete={() => {}}
        onAddKeyResult={async () => {}}
        onUpdateKeyResult={async () => {}}
        onCheckedIn={() => {}}
        orgId="org"
        projectId="p1"
        expanded
      />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("a cancelled objective on the card", () => {
  it("says Cancelled once, from its status, with no stoplight beside it", () => {
    // Control: an active one past pace shows its stoplight.
    renderCard(objective({ status: "ACTIVE", health: "behind" }));
    expect(screen.getByText("Behind")).toBeTruthy();
    cleanup();

    renderCard(objective({ status: "CANCELLED", health: "cancelled" }));
    expect(screen.getAllByText("Cancelled")).toHaveLength(1);
    expect(screen.queryByText("Behind")).toBeNull();
  });

  it("names a cancelled dependency as cancelled", () => {
    renderCard(objective({ dependsOn: [dependency({ status: "CANCELLED", health: "cancelled" })] }));
    expect(screen.getByText("· Cancelled")).toBeTruthy();
  });
});

describe("a 0% progress bar", () => {
  it("has a track in the border colour, not the card's own surface", () => {
    renderCard(objective({ keyResults: [kr] }));
    // The objective's bar and the key result's bar both read 0%.
    const tracks = screen.getAllByText("0%").map((pct) => pct.previousElementSibling as HTMLElement);
    expect(tracks).toHaveLength(2);
    for (const track of tracks) {
      expect(track.className).toContain("bg-[var(--border)]");
      expect(track.className).not.toContain("bg-muted");
    }
  });
});

describe("a key result row", () => {
  it("names its actions menu, which was an unlabelled icon button", () => {
    renderCard(objective({ keyResults: [kr] }));
    expect(screen.getByRole("button", { name: "Key result actions" })).toBeTruthy();
  });
});
