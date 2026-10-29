// @vitest-environment jsdom
//
// BUG 635be41c — "cancelled/OBE should scratch out children like DONE does".
//
// The sub-items list struck through a DONE child and not a CANCELLED one, so
// abandoned work read as still outstanding. The predicate is unit-tested in
// `lib/work-items/done-state.test.ts`; this pins the WIRING, because a correct
// predicate the component does not call fixes nothing — the same trap that made
// the get_work_item spec vacuous earlier today.
//
// Asserts `data-done`, which the row already carried for exactly this purpose
// and which nothing asserted until now.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/components/providers/permissions-provider", () => ({
  usePermissions: () => ({ can: () => true }),
}));
vi.mock("@/components/chat/mention-typeahead", () => ({ useOrgMembers: () => ({ data: [] }) }));
vi.mock("@/components/mentions/entity-mention-picker", () => ({ EntityMentionPicker: () => null }));
vi.mock("@/components/mentions/hooks", () => ({ useRefResolver: () => new Map() }));
vi.mock("@/components/notes/editor/rich-text-editor", () => ({ NoteRichTextEditor: () => null }));
vi.mock("@/components/chat/markdown-content", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("@/components/mentions/mentioned-in", () => ({ MentionedIn: () => null }));
vi.mock("@/components/work-items/links-section", () => ({ WorkItemLinksSection: () => null }));
vi.mock("@/components/roadmap/roadmap-description-field", () => ({ RoadmapDescriptionField: () => null }));
vi.mock("@/components/files/work-item-document-source", () => ({ WorkItemDocumentSource: () => null }));
vi.mock("@/components/files/work-item-attachments", () => ({ WorkItemAttachments: () => null }));
vi.mock("@/hooks/use-work-item-types", () => ({
  selectableTypes: <T,>(types: T[]) => types,
  useWorkItemTypes: () => ({ types: [{ id: "wt", key: "software.story", name: "Story" }] }),
}));
vi.mock("@/hooks/use-custom-fields", () => ({
  useCustomFields: () => ({ fields: [] }),
  fieldAppliesToType: () => false,
}));
vi.mock("@/hooks/use-item-transitions", () => ({ useItemTransitions: () => null }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import type { WorkItem } from "@/types/models";

afterEach(() => cleanup());

const COLUMNS = [
  { key: "todo", name: "To Do", category: "TODO" },
  { key: "done", name: "Done", category: "DONE" },
  { key: "cancelled", name: "Cancelled", category: "CANCELLED" },
] as never[];

function item(over: Partial<WorkItem> & { id: string; ticketNumber: number; title: string }): WorkItem {
  return {
    description: "", columnKey: "todo", priority: "MEDIUM", workCategory: "BUSINESS",
    parentId: null, children: [], storyPoints: null, startDate: null, dueDate: null,
    intervalId: null, assigneeId: null, assignees: [], workItemTypeId: "wt",
    workItemType: { id: "wt", key: "software.task", name: "Task", icon: null, color: null },
    customFields: {}, ...over,
  } as unknown as WorkItem;
}

/**
 * The sub-item row for a child, found by its TITLE.
 *
 * Not by ticket label: that is rendered from a project-key prop this test does
 * not set, so matching it made the spec fail for a reason unrelated to the bug.
 */
function row(title: string): HTMLElement | null {
  return screen.getByText(title).closest("[data-sub-item]") as HTMLElement | null;
}

describe("sub-items strike-through", () => {
  it("strikes a CANCELLED child, not just a DONE one", () => {
    const parent = item({
      id: "P", ticketNumber: 1, title: "Parent",
      children: [
        item({ id: "A", ticketNumber: 2, title: "Shipped", columnKey: "done" }),
        item({ id: "B", ticketNumber: 3, title: "Abandoned", columnKey: "cancelled" }),
        item({ id: "C", ticketNumber: 4, title: "Live", columnKey: "todo" }),
      ] as never,
    });

    render(
      <CardDetailSheet
        item={parent} open onOpenChange={() => {}} orgId="o1" projectId="pr1"
        members={[]} intervals={[]} columns={COLUMNS} onUpdate={() => {}}
        projectItems={[parent]} onOpenItem={() => {}}
      />,
    );

    // Guards the guard: a missing row would make every getAttribute below
    // return undefined and the "not struck" assertion pass for free.
    for (const t of ["Shipped", "Abandoned", "Live"]) expect(row(t)).not.toBeNull();

    // The regression: before the fix this row had no data-done.
    expect(row("Abandoned")?.getAttribute("data-done")).toBe("true");
    // Control: DONE still strikes, so the change is additive...
    expect(row("Shipped")?.getAttribute("data-done")).toBe("true");
    // ...and live work is still NOT struck, so it is not striking everything.
    expect(row("Live")?.getAttribute("data-done")).toBeNull();
  });
});
