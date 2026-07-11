// @vitest-environment jsdom
// COSMOS-5: drag-reordering a parent's sub-items must persist each child's new
// sortOrder AND notify the parent view (onChildrenReordered) so date-ordered
// surfaces like the Timeline/Gantt can refresh to the chosen order instead of
// waiting out the query staleTime.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const childRef = (id: string, ticketNumber: number): WorkItemRef =>
  ({ id, title: `Child ${id}`, ticketNumber, workItemTypeId: "wt", columnKey: "todo" } as WorkItemRef);

function parentWithChildren(children: WorkItemRef[]): WorkItem {
  return {
    id: "P",
    ticketNumber: 1,
    title: "Parent",
    description: "",
    columnKey: "todo",
    priority: "MEDIUM",
    workCategory: "BUSINESS",
    parentId: null,
    children,
    storyPoints: null,
    startDate: null,
    dueDate: null,
    cycleId: null,
    assigneeId: null,
    assignees: [],
    workItemTypeId: "wt",
    workItemType: { id: "wt", key: "software.story", name: "Story", icon: null, color: null },
    customFields: {},
  } as unknown as WorkItem;
}

/** PUTs succeed; every on-open GET resolves empty. Captures the PUT bodies. */
function mockFetch(puts: { url: string; sortOrder: number }[]) {
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push({ url: String(url), sortOrder: body.sortOrder });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("CardDetailSheet — drag-reorder sub-items (COSMOS-5)", () => {
  it("persists the new sortOrder for every sibling and notifies the parent view", async () => {
    const puts: { url: string; sortOrder: number }[] = [];
    mockFetch(puts);
    const onChildrenReordered = vi.fn();

    render(
      <CardDetailSheet
        item={parentWithChildren([childRef("A", 11), childRef("B", 12), childRef("C", 13)])}
        open
        onOpenChange={() => {}}
        orgId="o1"
        projectId="pr1"
        members={[]}
        cycles={[]}
        columns={[{ key: "todo", name: "To Do" } as never]}
        onUpdate={() => {}}
        onChildrenReordered={onChildrenReordered}
      />,
    );

    // Three drag handles, one per sub-item (they only render when there are >1).
    const grips = await screen.findAllByLabelText("Drag to reorder");
    expect(grips).toHaveLength(3);

    // Drag the first sub-item (A) onto the second row (B's row) → order A,B,C
    // becomes B,A,C. Each row div owns the onDrop; the grip is its child.
    fireEvent.dragStart(grips[0]);
    fireEvent.drop(grips[1].parentElement as HTMLElement);

    await waitFor(() => expect(onChildrenReordered).toHaveBeenCalledTimes(1));

    // One PUT per sibling, writing a contiguous 0..n rank in the NEW order.
    expect(puts).toHaveLength(3);
    expect(puts.map((p) => p.sortOrder)).toEqual([0, 1, 2]);
    // New order is B(0), A(1), C(2): the moved item A is now rank 1.
    expect(puts[0].url).toContain("/B");
    expect(puts[1].url).toContain("/A");
    expect(puts[2].url).toContain("/C");
  });

  it("does not notify the parent view when the persist fails", async () => {
    global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response("nope", { status: 500 });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const onChildrenReordered = vi.fn();

    render(
      <CardDetailSheet
        item={parentWithChildren([childRef("A", 11), childRef("B", 12)])}
        open
        onOpenChange={() => {}}
        orgId="o1"
        projectId="pr1"
        members={[]}
        cycles={[]}
        columns={[{ key: "todo", name: "To Do" } as never]}
        onUpdate={() => {}}
        onChildrenReordered={onChildrenReordered}
      />,
    );

    const grips = await screen.findAllByLabelText("Drag to reorder");
    fireEvent.dragStart(grips[0]);
    fireEvent.drop(grips[1].parentElement as HTMLElement);

    // Give the failed PUT a tick to settle, then assert the callback stayed silent.
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(onChildrenReordered).not.toHaveBeenCalled();
  });
});

describe("CardDetailSheet — keyboard reorder + drop indicator (COSMOS-47)", () => {
  it("reorders sub-items with the arrow keys and persists the new order", async () => {
    const puts: { url: string; sortOrder: number }[] = [];
    mockFetch(puts);
    const onChildrenReordered = vi.fn();

    render(
      <CardDetailSheet
        item={parentWithChildren([childRef("A", 11), childRef("B", 12), childRef("C", 13)])}
        open
        onOpenChange={() => {}}
        orgId="o1"
        projectId="pr1"
        members={[]}
        cycles={[]}
        columns={[{ key: "todo", name: "To Do" } as never]}
        onUpdate={() => {}}
        onChildrenReordered={onChildrenReordered}
      />,
    );

    const grips = await screen.findAllByLabelText("Drag to reorder");
    // Each grip is a focusable button; ArrowDown moves its row down one slot.
    // A,B,C → B,A,C when A (the first grip) is pushed down.
    fireEvent.keyDown(grips[0], { key: "ArrowDown" });

    await waitFor(() => expect(onChildrenReordered).toHaveBeenCalledTimes(1));
    // Same persistence contract as the mouse path: one contiguous PUT per sibling.
    expect(puts).toHaveLength(3);
    expect(puts.map((p) => p.sortOrder)).toEqual([0, 1, 2]);
    expect(puts[0].url).toContain("/B");
    expect(puts[1].url).toContain("/A");
    expect(puts[2].url).toContain("/C");
  });

  it("ignores an arrow-key move past the ends of the list", async () => {
    const puts: { url: string; sortOrder: number }[] = [];
    mockFetch(puts);
    const onChildrenReordered = vi.fn();

    render(
      <CardDetailSheet
        item={parentWithChildren([childRef("A", 11), childRef("B", 12)])}
        open
        onOpenChange={() => {}}
        orgId="o1"
        projectId="pr1"
        members={[]}
        cycles={[]}
        columns={[{ key: "todo", name: "To Do" } as never]}
        onUpdate={() => {}}
        onChildrenReordered={onChildrenReordered}
      />,
    );

    const grips = await screen.findAllByLabelText("Drag to reorder");
    // ArrowUp on the first row would move it to index -1 — a no-op, no PUTs.
    fireEvent.keyDown(grips[0], { key: "ArrowUp" });

    await waitFor(() => expect(screen.getAllByLabelText("Drag to reorder")).toHaveLength(2));
    expect(puts).toHaveLength(0);
    expect(onChildrenReordered).not.toHaveBeenCalled();
  });

  it("flags the hovered row as the drop target while dragging, then clears it", async () => {
    mockFetch([]);

    render(
      <CardDetailSheet
        item={parentWithChildren([childRef("A", 11), childRef("B", 12), childRef("C", 13)])}
        open
        onOpenChange={() => {}}
        orgId="o1"
        projectId="pr1"
        members={[]}
        cycles={[]}
        columns={[{ key: "todo", name: "To Do" } as never]}
        onUpdate={() => {}}
      />,
    );

    const grips = await screen.findAllByLabelText("Drag to reorder");
    const rowC = grips[2].parentElement as HTMLElement;
    expect(rowC).not.toHaveAttribute("data-drop-target");

    // Start dragging A, hover C's row → C is marked as the landing spot.
    fireEvent.dragStart(grips[0]);
    fireEvent.dragOver(rowC);
    expect(rowC).toHaveAttribute("data-drop-target", "true");

    // Ending the drag removes the indicator.
    fireEvent.dragEnd(grips[0]);
    expect(rowC).not.toHaveAttribute("data-drop-target");
  });
});
