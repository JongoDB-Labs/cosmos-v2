// @vitest-environment jsdom
//
// BR: "we should replicate that for the Comments section on tickets in boards.
// let the input box grow as needed rather than having one statically defined
// huge input box." The composer on this sheet is the shared rich-text editor,
// mounted with no sizing of its own — so it took the NOTE editor's 300px resting
// height and every ticket opened with a 300px-tall empty box.
//
// rich-text-editor.test.tsx proves the editor HONOURS a compact sizing; this
// proves the sheet ASKS for one. Both halves are needed: the bug was a missing
// argument, not a broken editor.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NOTE_EDITOR_SIZING, type EditorSizing } from "@/components/notes/editor/sizing";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/projects/ENG" }));
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
// Stand in for the editor and publish the sizing it was handed, so a dropped
// prop is visible instead of silently falling back to the note default.
vi.mock("@/components/notes/editor/rich-text-editor", () => ({
  NoteRichTextEditor: ({
    ariaLabel,
    sizing = NOTE_EDITOR_SIZING,
  }: {
    ariaLabel?: string;
    sizing?: EditorSizing;
  }) => (
    <div
      data-testid="editor-stub"
      aria-label={ariaLabel ?? "Note content"}
      data-min-height={String(sizing.minHeight)}
      data-max-height={sizing.maxHeight == null ? "" : String(sizing.maxHeight)}
    />
  ),
}));
vi.mock("@/components/chat/markdown-content", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("@/components/mentions/mentioned-in", () => ({ MentionedIn: () => null }));
vi.mock("@/components/work-items/links-section", () => ({
  WorkItemLinksSection: () => null,
}));
vi.mock("@/components/files/work-item-document-source", () => ({
  WorkItemDocumentSource: () => null,
}));
vi.mock("@/hooks/use-work-item-types", () => ({
  selectableTypes: <T,>(types: T[]) => types,
  useWorkItemTypes: () => ({ types: [{ id: "wt", key: "s.story", name: "Story" }] }),
}));
vi.mock("@/hooks/use-custom-fields", () => ({
  useCustomFields: () => ({ fields: [] }),
  fieldAppliesToType: () => false,
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: () => Promise.resolve([]) }));

import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import { COMMENT_EDITOR_SIZING } from "@/components/notes/editor/sizing";
import type { WorkItem } from "@/types/models";

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  global.fetch = vi.fn(
    async () => new Response("[]", { status: 200 }),
  ) as unknown as typeof fetch;
});

afterEach(cleanup);

const ITEM = {
  id: "W1",
  ticketNumber: 1,
  title: "A ticket",
  description: "",
  columnKey: "todo",
  priority: "MEDIUM",
  workCategory: "BUSINESS",
  parentId: null,
  children: [],
  assignees: [],
  workItemTypeId: "wt",
  customFields: {},
} as unknown as WorkItem;

function renderSheet() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CardDetailSheet
        item={ITEM}
        open
        onOpenChange={() => {}}
        orgId="o1"
        projectId="p1"
        members={[]}
        intervals={[]}
        columns={[{ key: "todo", name: "To Do" } as never]}
        onUpdate={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("CardDetailSheet — the comment composer grows, it isn't pre-grown (BR)", () => {
  it("asks for the compact composer sizing, not the note editor's 300px", () => {
    renderSheet();
    const composer = screen.getByLabelText("Comment");
    expect(composer.dataset.minHeight).toBe(String(COMMENT_EDITOR_SIZING.minHeight));
    // The reported symptom, stated as an assertion.
    expect(Number(composer.dataset.minHeight)).toBeLessThan(NOTE_EDITOR_SIZING.minHeight);
  });

  it("caps how far it may grow, so a long comment scrolls instead of taking the sheet", () => {
    renderSheet();
    const composer = screen.getByLabelText("Comment");
    expect(composer.dataset.maxHeight).toBe(String(COMMENT_EDITOR_SIZING.maxHeight));
  });

  it("mounts exactly one composer, and it is the comment one", () => {
    renderSheet();
    // A second, note-sized editor lurking on this tab would reintroduce the
    // crater even with the composer fixed.
    expect(screen.getAllByTestId("editor-stub")).toHaveLength(1);
    expect(screen.queryByLabelText("Note content")).toBeNull();
  });
});
