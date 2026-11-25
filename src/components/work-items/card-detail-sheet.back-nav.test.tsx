// @vitest-environment jsdom
// COSMOS-252: drilling from a ticket into one of its sub-items used to be a
// one-way trip — the only control left was Close, which dismissed the panel back
// to the board and lost the originating ticket ("the only option is to close out
// and start again"). The sheet now keeps an in-memory history of the items it
// has navigated to, so:
//   - a Back control steps to the view it came from (one entry per click), and
//   - dismissing it from a sub-item returns to the originating ticket instead of
//     closing, which is the user's "close out the view but remain on the
//     original ticket".
// An item reached DIRECTLY (a board card, a deep link) has no earlier view, so
// it shows no Back control and closes as it always did.
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
// Stubbed for the same reason as the source chip above: a react-query consumer,
// and this suite renders the sheet without a QueryClientProvider.
vi.mock("@/components/files/work-item-attachments", () => ({
  WorkItemAttachments: () => null,
}));
vi.mock("@/hooks/use-work-item-types", () => ({
  selectableTypes: <T,>(types: T[]) => types,
  useWorkItemTypes: () => ({
    types: [{ id: "wt", key: "software.story", name: "Story" }],
  }),
}));
vi.mock("@/hooks/use-custom-fields", () => ({
  useCustomFields: () => ({ fields: [] }),
  fieldAppliesToType: () => false,
}));
vi.mock("@/hooks/use-item-transitions", () => ({ useItemTransitions: () => null }));
vi.mock("@/hooks/use-project-member-visibility", () => ({
  useMembersWhoCantSeeProject: () => null,
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

/** Parent "P" → sub-item "C" → sub-sub-item "G", two levels deep. */
const ITEMS: WorkItem[] = [
  makeItem({ id: "P", ticketNumber: 1, title: "Parent ticket" }),
  makeItem({ id: "C", ticketNumber: 2, title: "First subtask", parentId: "P" }),
  makeItem({ id: "G", ticketNumber: 3, title: "Nested subtask", parentId: "C" }),
];

const childRef = (i: WorkItem): WorkItemRef =>
  ({
    id: i.id,
    title: i.title,
    ticketNumber: i.ticketNumber,
    workItemTypeId: i.workItemTypeId,
    columnKey: i.columnKey,
  }) as WorkItemRef;

/** Server truth: each item's `children` derived from parentId, as GET returns. */
const withChildren = (i: WorkItem): WorkItem => ({
  ...i,
  children: ITEMS.filter((c) => c.parentId === i.id).map(childRef),
});

function mockFetch() {
  global.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    const single = /\/work-items\/([^/?]+)$/.exec(u);
    const found = single && ITEMS.find((i) => i.id === single[1]);
    if (found) {
      return new Response(JSON.stringify(withChildren(found)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

/**
 * The board-side model every caller of the sheet shares (kanban, backlog,
 * roadmap, timeline): the HOST owns which item id is open, and `onOpenItem`
 * just re-points it. `dismissed` records a real close reaching the board.
 */
function Harness({ startAt }: { startAt: string }) {
  const [detailId, setDetailId] = useState<string | null>(startAt);
  const [dismissed, setDismissed] = useState(false);
  const item = detailId ? withChildren(ITEMS.find((i) => i.id === detailId)!) : null;
  return (
    <>
      <div data-testid="dismissed">{dismissed ? "yes" : "no"}</div>
      <CardDetailSheet
        item={item}
        open={item !== null}
        onOpenChange={(o) => {
          if (!o) {
            setDismissed(true);
            setDetailId(null);
          }
        }}
        orgId="o1"
        projectId="pr1"
        members={[]}
        intervals={[]}
        columns={[{ key: "todo", name: "To Do" } as never]}
        onUpdate={() => {}}
        projectItems={ITEMS}
        onOpenItem={(id) => setDetailId(id)}
      />
    </>
  );
}

/** Which item the sheet is showing, read off its Title field. */
const shownTitle = () => (screen.getByLabelText("Title") as HTMLTextAreaElement).value;
const backButton = () => screen.queryByTestId("card-detail-back");

describe("CardDetailSheet — back navigation out of a sub-item (COSMOS-252)", () => {
  it("offers a Back control on a sub-item that returns to the originating ticket", async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<Harness startAt="P" />);

    // AC4: opened straight from the board — nothing to go back to.
    await waitFor(() => expect(shownTitle()).toBe("Parent ticket"));
    expect(backButton()).toBeNull();

    // Drill into the sub-item.
    await user.click(await screen.findByRole("button", { name: /First subtask/ }));
    await waitFor(() => expect(shownTitle()).toBe("First subtask"));

    // AC1: a visible Back control, naming where it goes.
    const back = backButton();
    expect(back).not.toBeNull();
    expect(back!.getAttribute("aria-label")).toBe("Back to #1 Parent ticket");

    // ...and it returns to the parent rather than closing the panel.
    await user.click(back!);
    await waitFor(() => expect(shownTitle()).toBe("Parent ticket"));
    expect(screen.getByTestId("dismissed").textContent).toBe("no");
    expect(backButton()).toBeNull();
  });

  it("steps back one view at a time through nested sub-items", async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<Harness startAt="P" />);

    await user.click(await screen.findByRole("button", { name: /First subtask/ }));
    await waitFor(() => expect(shownTitle()).toBe("First subtask"));
    await user.click(await screen.findByRole("button", { name: /Nested subtask/ }));
    await waitFor(() => expect(shownTitle()).toBe("Nested subtask"));

    // AC2: each Back is one hop along the history, not a jump to the root.
    expect(backButton()!.getAttribute("aria-label")).toBe("Back to #2 First subtask");
    await user.click(backButton()!);
    await waitFor(() => expect(shownTitle()).toBe("First subtask"));

    expect(backButton()!.getAttribute("aria-label")).toBe("Back to #1 Parent ticket");
    await user.click(backButton()!);
    await waitFor(() => expect(shownTitle()).toBe("Parent ticket"));
    expect(backButton()).toBeNull();
    expect(screen.getByTestId("dismissed").textContent).toBe("no");
  });

  it("closing a sub-item returns to the originating ticket, not the board", async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<Harness startAt="P" />);

    await user.click(await screen.findByRole("button", { name: /First subtask/ }));
    await waitFor(() => expect(shownTitle()).toBe("First subtask"));
    await user.click(await screen.findByRole("button", { name: /Nested subtask/ }));
    await waitFor(() => expect(shownTitle()).toBe("Nested subtask"));

    // AC3: Close from two levels down lands on the ticket it all started from,
    // with the panel still up.
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(shownTitle()).toBe("Parent ticket"));
    expect(screen.getByTestId("dismissed").textContent).toBe("no");

    // A second Close, now on the originating ticket, really does dismiss.
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.getByTestId("dismissed").textContent).toBe("yes"),
    );
  });

  it("shows no Back control on a sub-item opened directly, and closes to the board", async () => {
    mockFetch();
    const user = userEvent.setup();
    // AC4: the deep-link case — the sub-item IS the first view of the session.
    render(<Harness startAt="C" />);

    await waitFor(() => expect(shownTitle()).toBe("First subtask"));
    expect(backButton()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.getByTestId("dismissed").textContent).toBe("yes"),
    );
  });
});
