// @vitest-environment jsdom
// A sub-item starts with its PARENT's assignees: a task usually belongs to
// whoever owns the story. The inherited set is a default, not a choice, so if
// the server refuses it (an assignee has left the org, or a create rule forbids
// work for them) the sub-item is created unassigned instead of failing.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
// Stubbed for the same reason as the source chip above: it is a react-query
// consumer, and this suite renders the sheet without a QueryClientProvider.
vi.mock("@/components/files/work-item-attachments", () => ({
  WorkItemAttachments: () => null,
}));
vi.mock("@/hooks/use-work-item-types", () => ({
  // Fixtures here contain no shadow types, so a passthrough matches the real
  // filter exactly; use-work-item-types.test.ts covers the filtering itself.
  selectableTypes: <T,>(types: T[]) => types,
  useWorkItemTypes: () => ({
    types: [
      { id: "wt", key: "software.story", name: "Story" },
      { id: "wt2", key: "software.bug", name: "Bug" },
    ],
  }),
}));
vi.mock("@/hooks/use-custom-fields", () => ({
  useCustomFields: () => ({ fields: [] }),
  fieldAppliesToType: () => false,
}));
// The workflow's transitions: unknown here, so every status is offered.
vi.mock("@/hooks/use-item-transitions", () => ({ useItemTransitions: () => null }));
// A react-query consumer too (the marks on assignees who can't see the
// project), and this suite renders the sheet without a QueryClientProvider.
vi.mock("@/hooks/use-project-member-visibility", () => ({ useMembersWhoCantSeeProject: () => null }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import type { WorkItem } from "@/types/models";
import { toast } from "sonner";

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture || (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture || (() => {});
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture || (() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(toast.warning).mockClear();
});

function parent(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "P", ticketNumber: 1, title: "Parent story",
    description: "", columnKey: "todo", priority: "MEDIUM", workCategory: "BUSINESS",
    parentId: null, children: [], storyPoints: null, startDate: null, dueDate: null,
    intervalId: null, assigneeId: null, assignees: [], workItemTypeId: "wt",
    workItemType: { id: "wt", key: "software.story", name: "Story", icon: null, color: null },
    customFields: {},
    ...over,
  } as unknown as WorkItem;
}

/** Records every create POST body; `refuse` makes assigned creates fail. */
function mockServer(refuse?: number) {
  const posts: Record<string, unknown>[] = [];
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if ((init?.method ?? "GET") === "POST" && /\/work-items$/.test(u)) {
      const body = JSON.parse(String(init!.body));
      posts.push(body);
      if (refuse && body.assigneeIds) {
        return new Response(JSON.stringify({ error: "refused" }), { status: refuse });
      }
      const child = parent({ id: `c${posts.length}`, ticketNumber: 100 + posts.length, title: body.title, parentId: "P" });
      return new Response(JSON.stringify(child), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return posts;
}

function renderSheet(item: WorkItem) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
    <CardDetailSheet
      item={item}
      open
      onOpenChange={() => {}}
      orgId="o1"
      projectId="pr1"
      members={[]}
      intervals={[]}
      columns={[{ key: "todo", name: "To Do" } as never]}
      onUpdate={() => {}}
      projectItems={[item]}
    />
    </QueryClientProvider>,
  );
}

async function addSubItem(title: string) {
  const user = userEvent.setup();
  const input = await screen.findByPlaceholderText("Add a sub-item…");
  await user.type(input, title);
  await user.click(screen.getByRole("button", { name: /^Add$/ }));
}

describe("CardDetailSheet — a sub-item inherits its parent's assignees", () => {
  it("sends every parent assignee", async () => {
    const posts = mockServer();
    renderSheet(parent({ assignees: [{ userId: "u1" }, { userId: "u3" }] as never, assigneeId: "u1" }));
    await addSubItem("Child task");
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].assigneeIds).toEqual(["u1", "u3"]);
  });

  it("falls back to the legacy single assignee", async () => {
    const posts = mockServer();
    renderSheet(parent({ assignees: [], assigneeId: "u7" }));
    await addSubItem("Child task");
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].assigneeIds).toEqual(["u7"]);
  });

  it("stays unassigned under an unassigned parent", async () => {
    const posts = mockServer();
    renderSheet(parent());
    await addSubItem("Child task");
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty("assigneeIds");
  });

  it.each([403, 422])("creates it unassigned, and says so, when the server refuses the assignee (%i)", async (status) => {
    const posts = mockServer(status);
    renderSheet(parent({ assignees: [{ userId: "gone" }] as never, assigneeId: "gone" }));
    await addSubItem("Child task");
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0].assigneeIds).toEqual(["gone"]);
    expect(posts[1]).not.toHaveProperty("assigneeIds");
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    // The child made it in.
    expect(await screen.findByText("Child task")).toBeTruthy();
  });
});
