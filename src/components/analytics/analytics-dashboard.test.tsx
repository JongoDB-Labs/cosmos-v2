// @vitest-environment jsdom
// Regression for COSMOS-22: the analytics dashboard crashed with
// "Cannot read properties of undefined (reading 'length')" when a tab's
// API returned a 200 whose body was missing the nested arrays the charts
// read `.length`/`.map` on (stale cache / partial payload / shape drift).
// The Feedback and Project Detail tabs only checked `!data`/`!detail`, not the
// nested fields, so a partial-but-non-null object slipped through and threw
// during render. These tests feed each tab an empty object and assert it
// renders its empty state instead of crashing.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AnalyticsDashboard } from "./analytics-dashboard";

// base-ui primitives (the Project Detail tab's Select) touch ResizeObserver on
// mount; jsdom doesn't provide it.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const jsonRes = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;

// Routes each analytics fetch to a deliberately partial 200 (missing the array
// fields) so we exercise the undefined-data path the ticket describes.
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/analytics/feedback")) return jsonRes({}); // no counts/totals/trend/recent
  if (url.includes("/analytics/projects/")) return jsonRes({ projectName: "Proj" }); // no arrays
  if (url.endsWith("/projects")) return jsonRes([{ id: "p1", name: "Proj", key: "P" }]);
  if (url.includes("/analytics/portfolio")) return jsonRes([]);
  return jsonRes({});
});

// Turns a render-time throw into a visible sentinel so we can assert on it
// rather than the test process crashing.
class Boundary extends React.Component<
  { children: React.ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  render() {
    return this.state.crashed ? <div data-testid="crashed" /> : this.props.children;
  }
}

describe("AnalyticsDashboard — tolerates undefined-array API responses", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("renders the Feedback tab's empty state instead of throwing", async () => {
    render(
      <Boundary>
        <AnalyticsDashboard orgId="org-1" />
      </Boundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Feedback/ }));

    expect(await screen.findByText(/No feedback submitted yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("crashed")).not.toBeInTheDocument();
  });

  it("renders the Project Detail tab's empty charts instead of throwing", async () => {
    render(
      <Boundary>
        <AnalyticsDashboard orgId="org-1" />
      </Boundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Project Detail/ }));

    // The chart headings only commit once `detail` is populated and the charts
    // grid renders — pre-fix, reading `detail.byType.length` on the partial
    // response throws before any of this render commits, so the heading never
    // appears (and the boundary trips instead).
    expect(await screen.findByText("Items by Type")).toBeInTheDocument();
    expect(screen.getAllByText(/No data available/i).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("crashed")).not.toBeInTheDocument();
  });
});
