// @vitest-environment jsdom
//
// Same class as the reported "changed interval to Unknown" on the Activity page:
// the phrase resolves id-valued fields through caller-supplied lookups, so a
// field whose lookup nobody wired renders with no name at all. This sheet's
// Activity tab wired user / interval / status but NOT type, so a retype read
// "changed type to Unknown". Locks all four, and locks that an id we cannot name
// is passed over in silence rather than asserted as "Unknown".
//
// Assertions read whole phrases rather than isolated words: the words also occur
// in the metadata pickers above, and a correct lookup inside a broken sentence
// is not a fix.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  // The picker hides shadow types; the activity lookup must see the FULL list,
  // which is why the sheet resolves against `types`, not the filtered options.
  selectableTypes: <T,>(types: T[]) => types,
  useWorkItemTypes: () => ({
    types: [
      { id: "wt", key: "s.story", name: "Story" },
      { id: "wt-bug", key: "s.bug", name: "Bug" },
    ],
  }),
}));
vi.mock("@/hooks/use-custom-fields", () => ({
  useCustomFields: () => ({ fields: [] }),
  fieldAppliesToType: () => false,
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: () => Promise.resolve([]) }));

import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import type { Interval, OrgMember, WorkItem } from "@/types/models";

/** An interval that no longer exists — nothing can resolve this. */
const GONE = "9a3e21c0-0000-4000-8000-000000000000";

const ACTIVITIES = [
  { id: "1", action: "updated", field: "workItemTypeId", oldValue: "wt", newValue: "wt-bug", createdAt: "2026-07-20T10:00:00.000Z" },
  { id: "2", action: "updated", field: "intervalId", oldValue: null, newValue: "int-1", createdAt: "2026-07-20T10:01:00.000Z" },
  { id: "3", action: "updated", field: "assigneeId", oldValue: null, newValue: "u1", createdAt: "2026-07-20T10:02:00.000Z" },
  { id: "4", action: "updated", field: "columnKey", oldValue: "todo", newValue: "doing", createdAt: "2026-07-20T10:03:00.000Z" },
  { id: "5", action: "updated", field: "intervalId", oldValue: "int-1", newValue: GONE, createdAt: "2026-07-20T10:04:00.000Z" },
];

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const href = String(url);
    if (href.endsWith("/activity")) {
      return new Response(JSON.stringify(ACTIVITIES), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;
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

/** Renders the sheet, switches to Activity, and returns the tab's rendered text. */
async function activityTabText(): Promise<string> {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CardDetailSheet
        item={ITEM}
        open
        onOpenChange={() => {}}
        orgId="o1"
        projectId="p1"
        members={[
          { userId: "u1", user: { id: "u1", displayName: "Dana Reyes" } } as unknown as OrgMember,
        ]}
        intervals={[{ id: "int-1", name: "Sprint 1" } as unknown as Interval]}
        columns={[
          { key: "todo", name: "To Do" } as never,
          { key: "doing", name: "In Progress" } as never,
        ]}
        onUpdate={() => {}}
      />
    </QueryClientProvider>,
  );

  // The tab's own count proves the rows arrived before we switch to them.
  const tab = await screen.findByRole("button", { name: `Activity (${ACTIVITIES.length})` });
  await userEvent.click(tab);
  const rows = await screen.findAllByText("changed", { exact: false });
  return rows.map((r) => r.textContent ?? "").join("\n");
}

describe("CardDetailSheet Activity tab — every id-valued field gets a name", () => {
  it("names the type a retype went from and to (the unwired lookup here)", async () => {
    expect(await activityTabText()).toContain("changed type from Story to Bug");
  });

  it("names the interval, the person and the status lane", async () => {
    const text = await activityTabText();
    expect(text).toContain("changed interval to Sprint 1");
    expect(text).toContain("changed assignee to Dana Reyes");
    expect(text).toContain("changed status from To Do to In Progress");
  });

  it("makes no claim about a since-deleted interval — no 'Unknown', no raw id", async () => {
    const text = await activityTabText();
    // The row still reports WHAT changed and the value it left.
    expect(text).toContain("changed interval from Sprint 1");
    expect(text).not.toContain("Unknown");
    expect(text).not.toContain(GONE);
    expect(text).not.toContain("Sprint 1 to");
  });
});
