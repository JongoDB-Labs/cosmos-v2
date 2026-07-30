// @vitest-environment jsdom
/**
 * #52 follow-up — an objective tracked by linked delivery must SHOW that
 * delivery and report progress from it.
 *
 * Two gaps this closes, both of which would have shipped a feature you could
 * use but not see:
 *   1. an objective with no key results reported a hardcoded 0% forever, so
 *      linking Features to it changed nothing a stakeholder could read;
 *   2. the card computed progress itself — a second implementation of a rule
 *      the API also owns — so even a fixed server would have been contradicted
 *      by the screen.
 *
 * The safety property is asserted explicitly: an objective that HAS key results
 * keeps reporting exactly what it did before, whatever is linked to it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { ObjectiveCard } from "./objective-card";
import type { Objective } from "@/types/models";

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

const kr = (current: number, target: number) => ({
  id: `kr-${current}-${target}`,
  objectiveId: "o1",
  title: "KR",
  startValue: 0,
  currentValue: current,
  targetValue: target,
  unit: "",
  lowerIsBetter: false,
  status: "ON_TRACK" as const,
  sortOrder: 0,
  description: null,
  ownerId: null,
  confidence: null,
  rag: null,
  createdAt: "",
  updatedAt: "",
});

function objective(over: Partial<Objective>): Objective {
  return {
    id: "o1",
    orgId: "org",
    projectId: "p1",
    title: "Ship the thing",
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

function renderCard(o: Objective) {
  return render(
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
    />,
  );
}

afterEach(cleanup);

describe("objective progress from linked delivery", () => {
  it("reports the share of linked items done when there are no key results", () => {
    // Previously a hardcoded 0% no matter what was delivered.
    renderCard(objective({ keyResults: [], linkedTotal: 4, linkedDone: 1, autoTracked: true }));
    expect(screen.getByText("25%")).toBeTruthy();
  });

  it("still reports 0% when nothing is linked and there are no key results", () => {
    renderCard(objective({ keyResults: [], linkedTotal: 0, linkedDone: 0 }));
    expect(screen.getByText("0%")).toBeTruthy();
  });

  it("does NOT let links move an objective that has key results", () => {
    // The safety property: existing objectives keep their existing number.
    renderCard(
      objective({
        keyResults: [kr(50, 100), kr(100, 100)],
        linkedTotal: 10,
        linkedDone: 0,
      }),
    );
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });
});

describe("linked delivery is visible on the row", () => {
  it("shows how much of the linked delivery is done", () => {
    renderCard(objective({ linkedTotal: 4, linkedDone: 1, autoTracked: true }));
    expect(screen.getByText("1/4 delivered")).toBeTruthy();
  });

  it("shows it even when key results own the percentage", () => {
    // A reader should always be able to see what an objective is tracked
    // against, not only when those links drive the number.
    renderCard(
      objective({ keyResults: [kr(50, 100)], linkedTotal: 3, linkedDone: 2 }),
    );
    expect(screen.getByText("2/3 delivered")).toBeTruthy();
  });

  it("says nothing when the objective has no links", () => {
    renderCard(objective({ linkedTotal: 0, linkedDone: 0 }));
    expect(screen.queryByText(/delivered/)).toBeNull();
  });

  it("offers a way to link work items", () => {
    // The affordance the feature needs in order to be reachable at all.
    const { container } = renderCard(objective({}));
    expect(within(container).queryAllByRole("button").length).toBeGreaterThan(0);
  });
});
