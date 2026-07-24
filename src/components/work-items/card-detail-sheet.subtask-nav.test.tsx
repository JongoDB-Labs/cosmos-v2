// @vitest-environment jsdom
// COSMOS-92: creating a sub-item, opening it, then navigating BACK to the parent
// must still show the sub-item under the parent (no manual refresh). Models the
// reactive-by-id board pattern (Timeline / Roadmap): a `detailId` state + a
// `detailItem` DERIVED from the items query, with `onItemCreated` = a refetch.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/providers/permissions-provider", () => ({
  usePermissions: () => ({ can: () => true }),
}));
vi.mock("@/components/chat/mention-typeahead", () => ({
  useOrgMembers: () => ({ data: [] }),
}));
vi.mock("@/components/mentions/entity-mention-picker", () => ({
  EntityMentionPicker: () => null,
}));
vi.mock("@/components/mentions/hooks", () => ({ useRefResolver: () => new Map() }));
vi.mock("@/components/chat/markdown-content", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("@/components/mentions/mentioned-in", () => ({ MentionedIn: () => null }));
vi.mock("@/components/work-items/links-section", () => ({
  WorkItemLinksSection: () => null,
}));
vi.mock("@/components/roadmap/roadmap-description-field", () => ({
  RoadmapDescriptionField: () => null,
}));
vi.mock("@/components/files/work-item-document-source", () => ({
  WorkItemDocumentSource: () => null,
}));
vi.mock("@/hooks/use-custom-fields", () => ({
  useCustomFields: () => ({ fields: [] }),
  fieldAppliesToType: () => false,
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import type { WorkItem, WorkItemRef } from "@/types/models";

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  Element.prototype.hasPointerCapture =
    Element.prototype.hasPointerCapture || (() => false);
  Element.prototype.setPointerCapture =
    Element.prototype.setPointerCapture || (() => {});
  Element.prototype.releasePointerCapture =
    Element.prototype.releasePointerCapture || (() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeItem(
  over: Partial<WorkItem> & { id: string; ticketNumber: number; title: string },
): WorkItem {
  return {
    description: "",
    columnKey: "todo",
    priority: "MEDIUM",
    workCategory: "BUSINESS",
    parentId: null,
    children: [],
    storyPoints: null,
    startDate: null,
    dueDate: null,
    intervalId: null,
    assigneeId: null,
    assignees: [],
    workItemTypeId: "wt",
    workItemType: { id: "wt", key: "software.task", name: "Task", icon: null, color: null },
    customFields: {},
    ...over,
  } as unknown as WorkItem;
}

/**
 * Fake server: a mutable list whose `children` are recomputed from parentId —
 * exactly what GET /work-items returns (each parent embeds its children).
 */
function makeServer(initial: WorkItem[]) {
  const rows = initial.map((i) => ({ ...i }));
  let nextTicket = 100;
  const snapshot = (): WorkItem[] =>
    rows.map((r) => ({
      ...r,
      children: rows
        .filter((c) => c.parentId === r.id)
        .map(
          (c): WorkItemRef =>
            ({
              id: c.id,
              title: c.title,
              ticketNumber: c.ticketNumber,
              workItemTypeId: c.workItemTypeId,
              columnKey: c.columnKey,
            }) as WorkItemRef,
        ),
    }));
  const createChild = (title: string, parentId: string): WorkItem => {
    const child = makeItem({
      id: `srv-${nextTicket}`,
      ticketNumber: nextTicket++,
      title,
      parentId,
    });
    rows.push(child);
    return { ...child, children: [] } as WorkItem;
  };
  return { snapshot, createChild };
}

/** Mock fetch that drives the sheet against the fake server. */
function mockFetch(server: ReturnType<typeof makeServer>) {
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && /\/work-items$/.test(u)) {
      const body = JSON.parse(String(init!.body));
      const child = server.createChild(body.title, body.parentId);
      return new Response(JSON.stringify(child), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("CardDetailSheet — sub-item survives navigating child→parent (COSMOS-92)", () => {
  it("keeps the newly-created sub-item under the parent after opening it and coming back", async () => {
    const server = makeServer([makeItem({ id: "P", ticketNumber: 1, title: "Parent" })]);
    mockFetch(server);
    const user = userEvent.setup();

    function Harness() {
      const [items, setItems] = useState<WorkItem[]>(() => server.snapshot());
      const [detailId, setDetailId] = useState<string | null>("P");
      const detailItem = detailId ? items.find((i) => i.id === detailId) ?? null : null;
      return (
        <>
          {/* Board-level "open parent" control (outside the sheet). */}
          <button data-testid="open-parent" type="button" onClick={() => setDetailId("P")}>
            open-parent
          </button>
          <CardDetailSheet
            item={detailItem}
            open={detailItem !== null}
            onOpenChange={(o) => !o && setDetailId(null)}
            orgId="o1"
            projectId="pr1"
            members={[]}
            intervals={[]}
            columns={[{ key: "todo", name: "To Do" } as never]}
            onUpdate={(updated) =>
              setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)))
            }
            projectItems={items}
            onItemCreated={() => void Promise.resolve().then(() => setItems(server.snapshot()))}
            onOpenItem={(id) => setDetailId(id)}
          />
        </>
      );
    }

    render(<Harness />);

    // 1) Create a sub-item under the parent.
    const input = await screen.findByPlaceholderText("Add a sub-item…");
    await user.type(input, "My subtask");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));

    // AC1: it appears under the parent immediately.
    const subBtn = await screen.findByRole("button", { name: /My subtask/ });

    // 2) Open the sub-item.
    await user.click(subBtn);
    await waitFor(() => expect(screen.getByText(/Sub-items \(0\)/)).toBeTruthy());

    // 3) Navigate back to the parent (board control, hidden behind the modal —
    //    fireEvent bypasses the aria-hidden visibility gate).
    fireEvent.click(screen.getByTestId("open-parent"));

    // AC2: the sub-item must still be listed under the parent.
    await waitFor(() => expect(screen.getByText(/Sub-items \(1\)/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /My subtask/ })).toBeTruthy();
  });
});

describe("CardDetailSheet — kanban snapshot pattern: sub-item survives child→parent (COSMOS-92)", () => {
  it("keeps the sub-item under the parent when reopening the parent CARD after a realtime refetch", async () => {
    const server = makeServer([makeItem({ id: "P", ticketNumber: 1, title: "Parent" })]);
    mockFetch(server);
    const user = userEvent.setup();

    // Faithful kanban model: `detailItem` is a SNAPSHOT (setDetailItem), NOT
    // derived. onItemCreated appends the child to items. A "realtime refetch"
    // replaces items from the server WITHOUT touching detailItem. Navigating
    // back = re-clicking the parent card (reads the current items array).
    function Harness() {
      const [items, setItems] = useState<WorkItem[]>(() => server.snapshot());
      const [detailItem, setDetailItem] = useState<WorkItem | null>(
        () => server.snapshot().find((i) => i.id === "P") ?? null,
      );
      const openCardById = (id: string) =>
        setDetailItem(items.find((i) => i.id === id) ?? null);
      return (
        <>
          {/* Board card re-click (reads current items snapshot). */}
          <button data-testid="click-parent-card" type="button" onClick={() => openCardById("P")}>
            parent-card
          </button>
          {/* Simulate the debounced realtime refetch replacing items only. */}
          <button data-testid="realtime-refetch" type="button" onClick={() => setItems(server.snapshot())}>
            refetch
          </button>
          <CardDetailSheet
            item={detailItem}
            open={detailItem !== null}
            onOpenChange={(o) => !o && setDetailItem(null)}
            orgId="o1"
            projectId="pr1"
            members={[]}
            intervals={[]}
            columns={[{ key: "todo", name: "To Do" } as never]}
            onUpdate={(updated) => {
              setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
              setDetailItem((cur) => (cur && cur.id === updated.id ? updated : cur));
            }}
            onDelete={() => {}}
            projectItems={items}
            onItemCreated={(child) => setItems((prev) => [...prev, child])}
            onOpenItem={openCardById}
          />
        </>
      );
    }

    render(<Harness />);

    // 1) Create the sub-item.
    const input = await screen.findByPlaceholderText("Add a sub-item…");
    await user.type(input, "My subtask");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));
    await screen.findByRole("button", { name: /My subtask/ });

    // 2) A realtime refetch lands (replaces items with server truth).
    fireEvent.click(screen.getByTestId("realtime-refetch"));

    // 3) Open the sub-item (in-sheet nav).
    await user.click(screen.getByRole("button", { name: /My subtask/ }));
    await waitFor(() => expect(screen.getByText(/Sub-items \(0\)/)).toBeTruthy());

    // 4) Navigate back to the parent by re-clicking its card.
    fireEvent.click(screen.getByTestId("click-parent-card"));

    // AC2: the sub-item is still listed under the parent.
    await waitFor(() => expect(screen.getByText(/Sub-items \(1\)/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /My subtask/ })).toBeTruthy();
  });
});

describe("CardDetailSheet — reconciles Sub-items with server truth on open (COSMOS-92 AC3/AC4)", () => {
  it("shows a persisted sub-item even when the item.children prop is stale/empty", async () => {
    // Server truth: parent P HAS a child C. The caller, however, hands the sheet
    // a STALE parent whose `children` is empty (e.g. a cache that missed the
    // create, or a partial read). The sheet must reflect the persisted sub-item
    // on open — not the stale prop — without a manual page refresh.
    const serverChild: WorkItemRef = {
      id: "C1",
      title: "Persisted subtask",
      ticketNumber: 42,
      workItemTypeId: "wt",
      columnKey: "todo",
    } as WorkItemRef;

    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      // Single-item GET returns the authoritative children.
      if (method === "GET" && /\/work-items\/P$/.test(u)) {
        return new Response(
          JSON.stringify(makeItem({ id: "P", ticketNumber: 1, title: "Parent", children: [serverChild] } as never)),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const staleParent = makeItem({ id: "P", ticketNumber: 1, title: "Parent", children: [] });

    render(
      <CardDetailSheet
        item={staleParent}
        open
        onOpenChange={() => {}}
        orgId="o1"
        projectId="pr1"
        members={[]}
        intervals={[]}
        columns={[{ key: "todo", name: "To Do" } as never]}
        onUpdate={() => {}}
        projectItems={[staleParent]}
      />,
    );

    // AC3/AC4: the persisted sub-item surfaces from server truth, not the prop.
    await waitFor(() => expect(screen.getByText(/Sub-items \(1\)/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Persisted subtask/ })).toBeTruthy();
  });
});
