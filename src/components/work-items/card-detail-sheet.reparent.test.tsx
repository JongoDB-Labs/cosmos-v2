// @vitest-environment jsdom
// COSMOS-67 (feedback 7d1ae4d2): assigning / reassigning a parent from a child's
// detail sheet must keep BOTH sides consistent immediately — the parent's
// sub-item (children) list gains the child, the former parent loses it — WITHOUT
// hijacking the sheet the user is editing. Boards mirror every `onUpdate` from
// the sheet into their open `detailItem`; because re-parenting also patches the
// parent rows, doing that unconditionally flipped the sheet from the child to
// the parent. `syncOpenDetail` (used by the kanban + backlog boards) only
// re-points the open sheet when the updated row IS the one on screen.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
vi.mock("@/components/notes/editor/rich-text-editor", () => ({ NoteRichTextEditor: () => null }));
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
import { syncOpenDetail } from "@/lib/work-items/detail-sync";
import type { WorkItem } from "@/types/models";

beforeAll(() => {
  // base-ui Select needs these in jsdom.
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

function makeItem(over: Partial<WorkItem> & { id: string; ticketNumber: number; title: string }): WorkItem {
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

// Mimics a board (kanban/backlog): an open `detailItem` shown in the sheet, plus
// a map-replace onUpdate that mirrors the row back into the open sheet THROUGH
// `syncOpenDetail` — exactly what the real boards do.
function BoardHarness({ initial, openId }: { initial: WorkItem[]; openId: string }) {
  const [items, setItems] = useState<WorkItem[]>(initial);
  const [detailItem, setDetailItem] = useState<WorkItem | null>(
    () => initial.find((i) => i.id === openId) ?? null,
  );
  function handleItemUpdate(updated: WorkItem) {
    setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    setDetailItem((cur) => syncOpenDetail(cur, updated));
  }
  const childIdsOf = (id: string) =>
    (items.find((i) => i.id === id)?.children ?? []).map((c) => c.id).join(",");
  return (
    <>
      <div data-testid="open-id">{detailItem?.id}</div>
      <div data-testid="P1-children">{childIdsOf("P1")}</div>
      <div data-testid="P2-children">{childIdsOf("P2")}</div>
      <CardDetailSheet
        item={detailItem}
        open
        onOpenChange={() => {}}
        orgId="o1"
        projectId="pr1"
        members={[]}
        intervals={[]}
        columns={[{ key: "todo", name: "To Do" } as never]}
        onUpdate={handleItemUpdate}
        projectItems={items}
      />
    </>
  );
}

/** Mock fetch: PUT echoes back the child with the new parentId; every other
 *  on-open request (comments/activity/watch) resolves empty. */
function mockFetchForChild(childId: string) {
  global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify(makeItem({ id: childId, ticketNumber: 9, title: "Child", parentId: body.parentId ?? null })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

async function pickParent(labelName: RegExp) {
  const user = userEvent.setup();
  const trigger = await screen.findByLabelText("Parent");
  await user.click(trigger);
  const option = await screen.findByRole("option", { name: labelName });
  await user.click(option);
}

describe("CardDetailSheet — parent assignment stays bidirectional without hijacking the sheet", () => {
  it("assigning a parent adds the child to that parent's children immediately (AC1/AC2)", async () => {
    mockFetchForChild("C");
    render(
      <BoardHarness
        openId="C"
        initial={[
          makeItem({ id: "P1", ticketNumber: 1, title: "Parent one" }),
          makeItem({ id: "C", ticketNumber: 9, title: "Child" }),
        ]}
      />,
    );

    await pickParent(/#1 Parent one/i);

    await waitFor(() => {
      expect(screen.getByTestId("P1-children").textContent).toBe("C");
    });
    // The sheet must stay on the child being edited, not flip to the parent.
    expect(screen.getByTestId("open-id").textContent).toBe("C");
  });

  it("reassigning to a new parent moves the child between both parents' children lists (AC3)", async () => {
    mockFetchForChild("C");
    render(
      <BoardHarness
        openId="C"
        initial={[
          makeItem({
            id: "P1",
            ticketNumber: 1,
            title: "Parent one",
            children: [{ id: "C", title: "Child", ticketNumber: 9, workItemTypeId: "wt", columnKey: "todo" }],
          } as never),
          makeItem({ id: "P2", ticketNumber: 2, title: "Parent two" }),
          makeItem({ id: "C", ticketNumber: 9, title: "Child", parentId: "P1" }),
        ]}
      />,
    );

    await pickParent(/#2 Parent two/i);

    await waitFor(() => {
      expect(screen.getByTestId("P2-children").textContent).toBe("C");
    });
    // Former parent drops the child; sheet still shows the child.
    expect(screen.getByTestId("P1-children").textContent).toBe("");
    expect(screen.getByTestId("open-id").textContent).toBe("C");
  });
});
