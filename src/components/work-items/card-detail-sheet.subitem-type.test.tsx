// @vitest-environment jsdom
// COSMOS-71: adding a sub-item defaults its type to one hierarchy level below
// the parent (under an Epic → Story), and the default stays overridable before
// creation. Asserts the actual POST body sent to the create API.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
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
// The org's actual type hierarchy (mirrors the built-in software sector), so the
// sub-item default is derived from `defaultParentTypeKey`.
vi.mock("@/hooks/use-work-item-types", () => ({
  useWorkItemTypes: () => ({
    types: [
      { id: "epic", key: "software.epic", name: "Epic", sortOrder: 0, isBuiltIn: true, defaultParentTypeKey: null },
      { id: "story", key: "software.story", name: "Story", sortOrder: 1, isBuiltIn: true, defaultParentTypeKey: "software.epic" },
      { id: "task", key: "software.task", name: "Task", sortOrder: 2, isBuiltIn: true, defaultParentTypeKey: "software.story" },
      { id: "subtask", key: "software.subtask", name: "Subtask", sortOrder: 4, isBuiltIn: true, defaultParentTypeKey: "software.story" },
    ],
  }),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import type { WorkItem } from "@/types/models";

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

function epicParent(): WorkItem {
  return {
    id: "E",
    ticketNumber: 1,
    title: "Big Epic",
    description: "",
    columnKey: "todo",
    priority: "MEDIUM",
    workCategory: "BUSINESS",
    parentId: null,
    children: [],
    storyPoints: null,
    startDate: null,
    dueDate: null,
    cycleId: null,
    assigneeId: null,
    assignees: [],
    workItemTypeId: "epic",
    workItemType: { id: "epic", key: "software.epic", name: "Epic", icon: null, color: null },
    customFields: {},
  } as unknown as WorkItem;
}

/** Records every create POST body; replies with a minimal child. */
function mockCreateFetch(posts: Record<string, unknown>[]) {
  let nextTicket = 100;
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && /\/work-items$/.test(u)) {
      const body = JSON.parse(String(init!.body));
      posts.push(body);
      const ticket = nextTicket++;
      return new Response(
        JSON.stringify({
          id: `srv-${ticket}`,
          title: body.title,
          ticketNumber: ticket,
          workItemTypeId: body.workItemTypeId ?? "task",
          columnKey: body.columnKey,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

function renderSheet() {
  render(
    <CardDetailSheet
      item={epicParent()}
      open
      onOpenChange={() => {}}
      orgId="o1"
      projectId="pr1"
      members={[]}
      cycles={[]}
      columns={[{ key: "todo", name: "To Do" } as never]}
      onUpdate={() => {}}
      projectItems={[epicParent()]}
    />,
  );
}

describe("CardDetailSheet — sub-item type defaults from the parent hierarchy (COSMOS-71)", () => {
  it("defaults a sub-item under an Epic to Story (AC1)", async () => {
    const posts: Record<string, unknown>[] = [];
    mockCreateFetch(posts);
    const user = userEvent.setup();
    renderSheet();

    // The type picker is pre-selected to Story (one level below Epic).
    const select = (await screen.findByLabelText("Sub-item type")) as HTMLSelectElement;
    expect(select.value).toBe("story");

    await user.type(screen.getByPlaceholderText("Add a sub-item…"), "A story");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));

    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]).toMatchObject({ title: "A story", workItemTypeId: "story", parentId: "E" });
    // Sent as a resolved id, not a bare `type` string.
    expect(posts[0].type).toBeUndefined();
  });

  it("remains overridable before creation (AC3)", async () => {
    const posts: Record<string, unknown>[] = [];
    mockCreateFetch(posts);
    const user = userEvent.setup();
    renderSheet();

    const select = await screen.findByLabelText("Sub-item type");
    await user.selectOptions(select, "task");

    await user.type(screen.getByPlaceholderText("Add a sub-item…"), "Override me");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));

    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]).toMatchObject({ title: "Override me", workItemTypeId: "task", parentId: "E" });
  });
});
