// @vitest-environment jsdom
//
// COSMOS-89: "Split per assignee" is offered only on an item shared by two or
// more people, and says exactly who keeps the item and who gets a copy before
// anything is created.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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
// Stubbed for the same reason as the source chip above: it is a react-query
// consumer, and this suite renders the sheet without a QueryClientProvider.
vi.mock("@/components/files/work-item-attachments", () => ({
  WorkItemAttachments: () => null,
}));
vi.mock("@/hooks/use-work-item-types", () => ({
  // Fixtures here contain no shadow types, so a passthrough matches the real
  // filter exactly; use-work-item-types.test.ts covers the filtering itself.
  selectableTypes: <T,>(types: T[]) => types,
  useWorkItemTypes: () => ({ types: [{ id: "wt", key: "s.story", name: "Story" }] }),
}));
vi.mock("@/hooks/use-custom-fields", () => ({
  useCustomFields: () => ({ fields: [] }),
  fieldAppliesToType: () => false,
}));
// The workflow's transitions: unknown here, so every status is offered.
vi.mock("@/hooks/use-item-transitions", () => ({ useItemTransitions: () => null }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: () => Promise.resolve([]) }));

import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import type { WorkItem } from "@/types/models";

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (String(url).endsWith("/split-assignees") && init?.method === "POST") {
    return new Response(
      JSON.stringify({ keptAssigneeId: "ann", copies: [{ id: "c1", ticketNumber: 2 }] }),
      { status: 201 },
    );
  }
  return new Response("[]", { status: 200 });
});

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
});

const MEMBERS = [
  { userId: "ann", user: { displayName: "Ann Lee", email: "ann@x.io" } },
  { userId: "bo", user: { displayName: "Bo Chen", email: "bo@x.io" } },
];

function item(assignees: string[]): WorkItem {
  return {
    id: "W1",
    ticketNumber: 1,
    title: "Shared work",
    description: "",
    columnKey: "todo",
    priority: "MEDIUM",
    workCategory: "BUSINESS",
    parentId: null,
    children: [],
    assigneeId: assignees[0] ?? null,
    assignees: assignees.map((userId) => ({ userId })),
    workItemTypeId: "wt",
    customFields: {},
  } as unknown as WorkItem;
}

function renderSheet(assignees: string[]) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CardDetailSheet
        item={item(assignees)}
        open
        onOpenChange={() => {}}
        orgId="o1"
        projectId="p1"
        members={MEMBERS as never}
        intervals={[]}
        columns={[{ key: "todo", name: "To Do" } as never]}
        onUpdate={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("CardDetailSheet — Split per assignee (COSMOS-89)", () => {
  it("is not offered on an item with one assignee", () => {
    renderSheet(["ann"]);
    expect(screen.queryByRole("button", { name: "Split per assignee" })).toBeNull();
  });

  it("confirms who keeps the item and who gets a copy, then splits", async () => {
    renderSheet(["ann", "bo"]);

    fireEvent.click(screen.getByRole("button", { name: "Split per assignee" }));
    const dialog = await screen.findByRole("dialog", { name: "Split into one issue per assignee?" });
    expect(dialog.textContent).toContain("stays with Ann Lee");
    expect(dialog.textContent).toContain("Bo Chen each get their own copy");
    // Nothing is created until the user confirms.
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/split-assignees"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Split into 2 issues" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, init]) => String(u).endsWith("/W1/split-assignees") && init?.method === "POST",
        ),
      ).toBe(true),
    );
  });
});
