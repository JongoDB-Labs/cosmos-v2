// @vitest-environment jsdom
//
// What these panels must never do is state a number without stating what it is
// a number OF. The maths is tested in lib/dashboard/delivery-metrics.test.ts;
// what is tested here is that the disclosure reaches the screen — because a
// median cycle time over 3 of 96 finished items renders identically to one over
// all 96, and the coverage line is the only thing distinguishing them.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CycleTimePanel, ThroughputPanel, WorkTypeMixPanel } from "./delivery-panels";
import type { DeliveryItemLike } from "@/lib/dashboard/delivery-metrics";
import type { Interval } from "@/types/models";

function item(over: Partial<DeliveryItemLike> = {}): DeliveryItemLike {
  return {
    id: Math.random().toString(36).slice(2),
    intervalId: "s1",
    storyPoints: null,
    actualStart: null,
    completedAt: null,
    done: false,
    typeKey: "story",
    typeName: "Story",
    typeColor: "#3b82f6",
    workCategory: "BUSINESS",
    ...over,
  };
}

function tookDays(days: number, over: Partial<DeliveryItemLike> = {}): DeliveryItemLike {
  const end = new Date("2026-03-10T12:00:00Z");
  return item({
    done: true,
    actualStart: new Date(end.getTime() - days * 86_400_000),
    completedAt: end,
    ...over,
  });
}

const interval = (over: Partial<Interval>): Interval =>
  ({
    id: "s1",
    number: 1,
    name: "Sprint 1",
    status: "COMPLETED",
    intervalKind: "SPRINT",
    parentId: null,
    startDate: "2026-01-01T00:00:00Z",
    endDate: "2026-01-14T00:00:00Z",
    report: null,
    ...over,
  }) as Interval;

describe("cycle time discloses its coverage", () => {
  it("says how much of the finished work the median actually describes", () => {
    render(
      <CycleTimePanel
        items={[
          tookDays(2),
          tookDays(4),
          tookDays(6),
          ...Array.from({ length: 7 }, () => item({ done: true })),
        ]}
      />,
    );

    expect(screen.getByTestId("cycle-median")).toHaveTextContent("4.0d");
    // The load-bearing assertion: without this line the 4.0d reads as the
    // team's cycle time rather than three items' worth of it.
    expect(screen.getByText(/Measured over 3 of 10 finished items \(30%\)/)).toBeInTheDocument();
  });

  it("shows no number at all when nothing can be timed, and says why", () => {
    // "0d" here would be a lie about a team that ships. The panel must refuse
    // to produce a figure and explain what is missing instead.
    render(<CycleTimePanel items={Array.from({ length: 4 }, () => item({ done: true }))} />);

    expect(screen.queryByTestId("cycle-median")).not.toBeInTheDocument();
    expect(screen.getByText(/4 finished items, none carrying both a start/)).toBeInTheDocument();
  });

  it("distinguishes 'nothing finished' from 'nothing measurable'", () => {
    // Different problems with different fixes; one message for both teaches
    // neither team anything.
    render(<CycleTimePanel items={[item({ done: false })]} />);
    expect(screen.getByText(/Nothing here has finished yet/)).toBeInTheDocument();
  });

  it("surfaces items excluded for finishing before they started", () => {
    const broken = item({
      done: true,
      actualStart: new Date("2026-03-10T12:00:00Z"),
      completedAt: new Date("2026-03-01T12:00:00Z"),
    });
    render(<CycleTimePanel items={[tookDays(3), broken]} />);
    expect(screen.getByText(/1 excluded for finishing before they started/)).toBeInTheDocument();
  });

  it("reports sub-day work in hours rather than rounding it to zero days", () => {
    render(<CycleTimePanel items={[tookDays(0.25)]} />);
    expect(screen.getByTestId("cycle-median")).toHaveTextContent("6h");
    expect(screen.getByTestId("cycle-median")).not.toHaveTextContent("0d");
  });
});

describe("throughput does not present a partial sprint as a result", () => {
  const intervals = [
    interval({ id: "s1", number: 1, name: "Sprint 1", status: "COMPLETED" }),
    interval({ id: "s2", number: 2, name: "Sprint 2", status: "COMPLETED" }),
    interval({ id: "s3", number: 3, name: "Sprint 3", status: "ACTIVE" }),
  ];

  it("averages only the closed sprints and says how many", () => {
    render(
      <ThroughputPanel
        intervals={intervals}
        items={[
          ...Array.from({ length: 8 }, () => item({ intervalId: "s1", done: true })),
          ...Array.from({ length: 8 }, () => item({ intervalId: "s2", done: true })),
          item({ intervalId: "s3", done: true }),
        ]}
      />,
    );

    // 17 items across 3 sprints would average 5.7 if the running one counted.
    expect(screen.getByText(/Average 8\.0 items across 2 closed sprints/)).toBeInTheDocument();
  });

  it("omits the average rather than computing one from a single partial sprint", () => {
    render(
      <ThroughputPanel
        intervals={[intervals[2]]}
        items={[item({ intervalId: "s3", done: true })]}
      />,
    );
    expect(screen.getByText(/No sprint has closed yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Average/)).not.toBeInTheDocument();
  });

  it("excludes the Program Increment from the sprint comparison", () => {
    // A PI holds no work items of its own, so charting it draws a zero bar
    // beside real sprints and reads as an increment that delivered nothing.
    render(
      <ThroughputPanel
        intervals={[
          interval({ id: "pi1", number: 100, name: "PI-002", status: "ACTIVE", intervalKind: "PROGRAM_INCREMENT" }),
          intervals[0],
        ]}
        items={[item({ intervalId: "s1", done: true })]}
      />,
    );
    expect(screen.getByText(/Average 1\.0 items across 1 closed sprint/)).toBeInTheDocument();
  });

  it("says so when the project has no sprints, instead of drawing an empty axis", () => {
    render(<ThroughputPanel intervals={[]} items={[]} />);
    expect(screen.getByText(/no sprints yet/)).toBeInTheDocument();
  });
});

describe("work type mix reports both cuts and its estimate coverage", () => {
  it("shows the business/enabler split as a ratio", () => {
    render(
      <WorkTypeMixPanel
        items={[
          item({ workCategory: "BUSINESS" }),
          item({ workCategory: "BUSINESS" }),
          item({ workCategory: "BUSINESS" }),
          item({ typeKey: "spike", typeName: "Spike", workCategory: "ENABLER" }),
        ]}
      />,
    );
    expect(screen.getByText(/3 business · 1 enabler \(75% \/ 25%\)/)).toBeInTheDocument();
  });

  it("lists each type with its finished count", () => {
    render(
      <WorkTypeMixPanel
        items={[
          item({ typeKey: "bug", typeName: "Bug", done: true }),
          item({ typeKey: "bug", typeName: "Bug" }),
        ]}
      />,
    );
    expect(screen.getByTestId("work-type-bug")).toHaveTextContent("2 · 100% (1 done)");
  });

  it("qualifies the points figure when most items are unestimated", () => {
    render(
      <WorkTypeMixPanel
        items={[item({ storyPoints: 5 }), item(), item(), item()]}
      />,
    );
    expect(
      screen.getByText(/1 of 4 items are estimated, so counts are the reliable measure/),
    ).toBeInTheDocument();
  });
});
