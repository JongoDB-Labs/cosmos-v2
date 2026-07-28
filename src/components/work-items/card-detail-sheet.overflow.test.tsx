// @vitest-environment jsdom
//
// COSMOS-21, ported from the retired read-only IssueDetailSheet.
//
// That sheet was the only one carrying this fix, and it was only ever reachable
// from the Issues page. Now that every surface — Issues, Table, Calendar, RAID
// and the boards — opens THIS sheet, the regression has to be locked here or a
// single wide markdown table in a description drags the whole pane sideways.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
vi.mock("@/components/notes/editor/rich-text-editor", () => ({
  NoteRichTextEditor: () => null,
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
  useWorkItemTypes: () => ({ types: [{ id: "wt", key: "s.story", name: "Story" }] }),
}));
vi.mock("@/hooks/use-custom-fields", () => ({
  useCustomFields: () => ({ fields: [] }),
  fieldAppliesToType: () => false,
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: () => Promise.resolve([]) }));

import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import { RoadmapDescriptionField } from "@/components/roadmap/roadmap-description-field";
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
  title: "Wide content",
  description: "| a | b |\n| - | - |\n| 1 | 2 |",
  columnKey: "todo",
  priority: "MEDIUM",
  workCategory: "BUSINESS",
  parentId: null,
  children: [],
  assignees: [],
  workItemTypeId: "wt",
  customFields: {},
} as unknown as WorkItem;

function withClient(ui: React.ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>
  );
}

describe("CardDetailSheet — wide content stays reachable (COSMOS-21)", () => {
  it("pins the pane to vertical scroll so wide content can't jerk it sideways", () => {
    render(
      withClient(
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
        />,
      ),
    );

    const body = screen.getByTestId("card-detail-body");
    expect(body.className).toContain("overflow-y-auto");
    // Without this, overflow-y-auto alone promotes overflow-x to auto.
    expect(body.className).toContain("overflow-x-hidden");
  });

  it("gives the description its own horizontal scroller so wide markdown is reachable, not clipped", () => {
    render(
      withClient(
        <RoadmapDescriptionField
          value={"| a | b |\n| - | - |\n| 1 | 2 |"}
          onChange={() => {}}
          orgId="o1"
          projectId="p1"
          resetKey="W1"
        />,
      ),
    );

    // The pane hides overflow-x, so the preview must scroll on its own or wide
    // tables and code blocks become unreachable rather than merely awkward.
    const preview = screen.getByTestId("markdown-preview");
    expect(preview.className).toContain("overflow-x-auto");
    // Ordinary prose still wraps instead of forcing a scrollbar.
    expect(preview.className).toContain("break-words");
  });
});
