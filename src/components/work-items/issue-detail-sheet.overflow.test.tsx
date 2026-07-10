// @vitest-environment jsdom
// COSMOS-21 — the Issues detail pane (a fixed-width right drawer) clipped/janked
// on content wider than the pane. Root cause: the scroll body used only
// `overflow-y-auto`; per the CSS spec that promotes `overflow-x` to `auto`, so a
// wide markdown table / code block / long token in the description made the WHOLE
// pane (metadata grid included) scroll sideways instead of the wide block getting
// its own scrollbar. The fix pins the body to vertical scroll and gives the
// description block its own horizontal scroller so wide content stays reachable.
//
// jsdom can't do layout, so — like the MetricCard (COSMOS-20) guard — this locks
// the CSS-class invariants that produce the behavior.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Keep the markdown renderer inert: we only care that the description WRAPPER
// carries the horizontal-scroll affordance, not how markdown itself renders.
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock("remark-gfm", () => ({ default: () => null }));
// next/link needs the app-router context to be mounted; a plain anchor is enough.
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: unknown }) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

import { IssueDetailSheet, type IssueDetailRow } from "@/components/work-items/issue-detail-sheet";

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  // The on-open watch GET + description GET. Description carries a wide GFM table.
  global.fetch = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith("/watch")) {
      return new Response(JSON.stringify({ watching: false }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        data: {
          description:
            "| Environment | Region | p50 | p99 | Error rate | Notes |\n| --- | --- | --- | --- | --- | --- |\n| production | us-east-1 | 142ms | 1204ms | 0.42% | spikes under load |",
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ROW: IssueDetailRow = {
  id: "wi1",
  ticketKey: "PLAT-1042",
  title: "Investigate intermittent 500s on the work-item search endpoint",
  columnKey: "IN_PROGRESS",
  priority: "CRITICAL",
  type: { name: "Bug", icon: null },
  project: { id: "pr1", key: "PLAT", name: "Platform" },
  assignee: null,
  parent: null,
  storyPoints: null,
  tags: [],
  startDate: null,
  dueDate: null,
  completedAt: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
};

describe("IssueDetailSheet — wide content stays reachable (COSMOS-21)", () => {
  it("pins the pane body to vertical scroll so wide content can't jerk the whole pane sideways", async () => {
    render(
      <IssueDetailSheet
        row={ROW}
        open
        onOpenChange={() => {}}
        orgId="o1"
        orgSlug="acme"
        statuses={[{ key: "IN_PROGRESS", name: "In Progress", category: "IN_PROGRESS" }]}
      />,
    );

    const body = await screen.findByTestId("issue-detail-body");
    // Vertical scroll for the tall pane...
    expect(body.className).toContain("overflow-y-auto");
    // ...but NOT horizontal: without this, `overflow-y-auto` alone promotes
    // overflow-x to auto and the entire pane scrolls sideways on wide content.
    expect(body.className).toContain("overflow-x-hidden");
  });

  it("gives the description its own horizontal scroller so wide markdown (tables/code) is reachable, not clipped", async () => {
    render(
      <IssueDetailSheet
        row={ROW}
        open
        onOpenChange={() => {}}
        orgId="o1"
        orgSlug="acme"
        statuses={[{ key: "IN_PROGRESS", name: "In Progress", category: "IN_PROGRESS" }]}
      />,
    );

    // Renders once the on-open description fetch resolves.
    const desc = await screen.findByTestId("issue-detail-description");
    expect(desc.className).toContain("overflow-x-auto");
    // Prose text still wraps rather than forcing a scrollbar on ordinary copy.
    expect(desc.className).toContain("break-words");
  });
});
