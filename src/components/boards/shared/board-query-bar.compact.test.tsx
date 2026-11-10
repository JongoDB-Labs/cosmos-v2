// @vitest-environment jsdom
//
// The CQL band is ONE padded surface, not a card nested inside a band.
//
// Measured on prod at 2.514.0, a sprint board's chrome occupied 338 of 906
// viewport pixels (37%), and the single biggest piece was this band at 147px:
// a ~20px line naming the board's scope, the QueryBuilder, and the actions row.
// The builder drew itself as a card -- `rounded border bg-[var(--surface)] p-3`
// -- inside a band that already supplies `px-4 py-2` and a bottom border, so
// 26 of those pixels were framing inside framing.
//
// That matters because ffe324aa is specifically "pushes the kanban board itself
// down way too much to where you have no visibility", and this org has the
// query language ON -- so its boards render THIS component, not `FilterBar`.
// The band-merge work in 2.513.0/2.515.0 helps the FilterBar path most; this is
// the CQL path's share.
//
// jsdom computes no layout, so this cannot assert pixels. It asserts the two
// structural facts that produced them: the builder does not draw its own card
// here, and the board's scope shares a row rather than owning one.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// The real builder pulls in CodeMirror via next/dynamic. Stub it, but keep the
// `variant` it was handed observable -- that IS the thing under test, and a
// stub that swallowed it would make every assertion below vacuous.
const seen: { variant?: string }[] = [];
vi.mock("@/components/work-items/cql/query-builder", () => ({
  QueryBuilder: (props: { variant?: string }) => {
    seen.push({ variant: props.variant });
    return <div data-testid="builder" data-variant={props.variant ?? "card"} />;
  },
}));

import { BoardQueryBar } from "./board-query-bar";

type Q = Parameters<typeof BoardQueryBar>[0]["q"];
const q = (over: Partial<Q> = {}): Q =>
  ({
    enabled: true,
    keep: () => true,
    pending: false,
    baselineCql: 'project = "COSMOS"',
    problem: null,
    schema: { fields: [] },
    cql: "",
    setCql: () => {},
    mode: null,
    setMode: () => {},
    diagnostics: [],
    ...over,
  }) as unknown as Q;

afterEach(() => {
  cleanup();
  seen.length = 0;
});

describe("the CQL band is one padded surface", () => {
  it("renders the builder at all", () => {
    // Positive control for everything below.
    render(<BoardQueryBar orgId="o1" q={q()} />);
    expect(screen.getByTestId("builder")).toBeTruthy();
  });

  it("asks the builder NOT to draw its own card", () => {
    render(<BoardQueryBar orgId="o1" q={q()} />);
    expect(screen.getByTestId("builder").getAttribute("data-variant")).toBe("inline");
    expect(seen.at(-1)?.variant).toBe("inline");
  });

  it("puts the board's scope on the same row as the actions, not a row of its own", () => {
    render(
      <BoardQueryBar
        orgId="o1"
        q={q()}
        actions={<button type="button">New work item</button>}
      />,
    );
    const scope = screen.getByText(/This board shows/);
    const newIssue = screen.getByRole("button", { name: "New work item" });
    // Same parent row. Previously the scope line was a sibling of the builder,
    // one level up, and cost ~20px on every CQL board.
    expect(scope.closest("div")).toBe(newIssue.closest("div"));
  });

  it("keeps the long scope query readable without wrapping to more rows", () => {
    const long = 'project = "COSMOS" AND assignee = me AND priority IN (HIGH, CRITICAL) ORDER BY due';
    render(<BoardQueryBar orgId="o1" q={q({ baselineCql: long })} />);
    const scope = screen.getByText(/This board shows/);
    // Truncation is what stops a sentence-long saved query claiming two or
    // three rows above every board; the full text stays reachable.
    expect(scope.className).toMatch(/\btruncate\b/);
    expect(scope.getAttribute("title")).toBe(long);
  });

  it("still gives a problem priority over the scope, and keeps it an alert", () => {
    render(<BoardQueryBar orgId="o1" q={q({ problem: "field 'nope' is unknown" })} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/shows nothing/);
    // The scope line must not also render: two explanations of the same board.
    expect(screen.queryByText(/This board shows [^n]/)).toBeNull();
  });

  it("still shows the actions when there is no schema yet", () => {
    // The regression this component already carries a comment about: the band
    // returns null without a schema, and the actions must not go with it.
    render(
      <BoardQueryBar
        orgId="o1"
        q={q({ schema: null as unknown as Q["schema"] })}
        actions={<button type="button">New work item</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "New work item" })).toBeTruthy();
    expect(screen.queryByTestId("builder")).toBeNull();
  });
});
