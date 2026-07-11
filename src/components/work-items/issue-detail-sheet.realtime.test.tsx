// @vitest-environment jsdom
// COSMOS-14 — issue updates without a manual refresh. The org-wide Issues list
// and the project boards already refetch on the work-item SSE stream, but the
// detail sheet a user has OPEN rendered a frozen snapshot: another user changing
// the ticket's status / assignee / description left the open pane stale until it
// was closed and reopened. This locks the fix — when a work-item change for the
// open item arrives, the sheet re-pulls its display fields + description in the
// background (no skeleton flash, no clobbering the watch toggle).
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, act, cleanup, waitFor } from "@testing-library/react";

// Keep the markdown renderer inert — we only assert the text it's handed.
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock("remark-gfm", () => ({ default: () => null }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: unknown }) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

// Capture the realtime callback so the test can play the role of the SSE stream
// and fire a "this item changed" event on demand.
let fireRealtime: () => void = () => {};
vi.mock("@/hooks/use-work-item-realtime", () => ({
  useWorkItemRealtime: (_orgId: string, _projectId: string | null, onChange: () => void) => {
    fireRealtime = onChange;
  },
}));

import { IssueDetailSheet, type IssueDetailRow } from "@/components/work-items/issue-detail-sheet";

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

// Mutable server state the fetch mock reads from — flip it to simulate another
// user editing the ticket, then fire the realtime event.
const server = {
  row: null as IssueDetailRow | null,
  description: "original description",
  watching: false,
};

function installFetch() {
  global.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/watch")) {
      return new Response(JSON.stringify({ watching: server.watching }), { status: 200 });
    }
    // The IssueRow projection used to refresh the sheet's display fields.
    if (u.endsWith("/row")) {
      return new Response(JSON.stringify({ data: server.row }), { status: 200 });
    }
    // The full item GET (carries the description).
    return new Response(
      JSON.stringify({ data: { description: server.description } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

const ROW: IssueDetailRow = {
  id: "wi1",
  ticketKey: "ENG-42",
  title: "Original title",
  columnKey: "in_progress",
  priority: "MEDIUM",
  type: { name: "Task", icon: null },
  project: { id: "pr1", key: "ENG", name: "Engineering" },
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

const STATUSES = [
  { key: "in_progress", name: "In Progress", category: "IN_PROGRESS" },
  { key: "done", name: "Done", category: "DONE" },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  fireRealtime = () => {};
});

describe("IssueDetailSheet — live updates while open (COSMOS-14)", () => {
  it("reflects another user's edit (status, title, description) without a manual refresh", async () => {
    server.row = { ...ROW };
    server.description = "original description";
    installFetch();

    render(
      <IssueDetailSheet
        row={ROW}
        open
        onOpenChange={() => {}}
        orgId="o1"
        orgSlug="acme"
        statuses={STATUSES}
      />,
    );

    // Baseline: the snapshot the list handed us.
    expect(await screen.findByText("Original title")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(await screen.findByText("original description")).toBeInTheDocument();

    // Another user moves it to Done, renames it, and edits the description.
    server.row = { ...ROW, title: "Renamed by teammate", columnKey: "done" };
    server.description = "updated description";

    // The SSE stream delivers the change; the sheet refreshes in place.
    await act(async () => {
      fireRealtime();
    });

    await waitFor(() => {
      expect(screen.getByText("Renamed by teammate")).toBeInTheDocument();
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.getByText("updated description")).toBeInTheDocument();
    });
    // The stale values are gone — the pane didn't keep the old snapshot.
    expect(screen.queryByText("Original title")).not.toBeInTheDocument();
    expect(screen.queryByText("In Progress")).not.toBeInTheDocument();
  });

  it("ignores a live refresh whose payload is for a different item (no clobber)", async () => {
    server.row = { ...ROW };
    server.description = "original description";
    installFetch();

    render(
      <IssueDetailSheet
        row={ROW}
        open
        onOpenChange={() => {}}
        orgId="o1"
        orgSlug="acme"
        statuses={STATUSES}
      />,
    );

    expect(await screen.findByText("Original title")).toBeInTheDocument();

    // A refresh resolves with a row for a DIFFERENT id — the id guard drops it
    // rather than rendering someone else's ticket into this pane.
    server.row = { ...ROW, id: "OTHER", title: "A different ticket" };
    await act(async () => {
      fireRealtime();
    });

    // Give the async refresh a tick to settle, then confirm we still show ours.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Original title")).toBeInTheDocument();
    expect(screen.queryByText("A different ticket")).not.toBeInTheDocument();
  });
});
