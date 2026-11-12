// @vitest-environment jsdom
//
// Typing a comment on a work item re-rendered the WHOLE sheet, and every
// comment's markdown above the composer, once per keystroke: the draft lived
// in the sheet's own state. On an item with many comments that is the lag the
// report describes (and it is what turned #1367's duplicate keys into visibly
// multiplying links).
//
// The probes are counters in two mocks: `MarkdownContent` (one render per
// comment body) and `useWorkItemTypes`, which only CardDetailSheet itself calls
// in this tree, so it counts renders of the sheet. Each test that asserts ZERO
// first shows the same probe counting something, so a probe that cannot see a
// render is not mistaken for a sheet that does not render.
//
// The editor stub keeps what Lexical does: `initialMarkdown` is read once, at
// mount. That is what makes "the draft survives a remount" and "another item
// starts empty" real questions rather than ones a controlled stub would answer
// for free.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const renders = vi.hoisted(() => ({ markdown: 0, sheet: 0 }));

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
  NoteRichTextEditor: ({
    initialMarkdown,
    onChange,
    ariaLabel,
  }: {
    initialMarkdown: string;
    onChange: (markdown: string) => void;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel ?? "Note content"}
      defaultValue={initialMarkdown}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock("@/components/chat/markdown-content", () => ({
  MarkdownContent: ({ content }: { content: string }) => {
    renders.markdown++;
    return <div data-testid="comment-body">{content}</div>;
  },
}));
vi.mock("@/components/mentions/mentioned-in", () => ({ MentionedIn: () => null }));
vi.mock("@/components/work-items/links-section", () => ({
  WorkItemLinksSection: () => null,
}));
vi.mock("@/components/files/work-item-document-source", () => ({
  WorkItemDocumentSource: () => null,
}));
vi.mock("@/components/files/work-item-attachments", () => ({
  WorkItemAttachments: () => null,
}));
vi.mock("@/hooks/use-work-item-types", () => ({
  selectableTypes: <T,>(types: T[]) => types,
  useWorkItemTypes: () => {
    renders.sheet++;
    return { types: [{ id: "wt", key: "s.story", name: "Story" }] };
  },
}));
vi.mock("@/hooks/use-custom-fields", () => ({
  useCustomFields: () => ({ fields: [] }),
  fieldAppliesToType: () => false,
}));
vi.mock("@/hooks/use-item-transitions", () => ({ useItemTransitions: () => null }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: () => Promise.resolve([]) }));

import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import type { WorkItem } from "@/types/models";

const COMMENTS = 12;
const TYPED = "a new comment";

function item(id: string, title: string): WorkItem {
  return {
    id,
    ticketNumber: 1,
    title,
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
}
const W1 = item("W1", "First ticket");
const W2 = item("W2", "Second ticket");

function commentsFor(itemId: string) {
  return Array.from({ length: COMMENTS }, (_, i) => ({
    id: `${itemId}-c${i}`,
    content: `${itemId} comment ${i}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    authorName: "Ada",
  }));
}

let posted: Array<{ url: string; body: { content: string } }> = [];

beforeEach(() => {
  renders.markdown = 0;
  renders.sheet = 0;
  posted = [];
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = url.match(/work-items\/(W\d)\/comments$/);
    if (m && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { content: string };
      posted.push({ url, body });
      return new Response(
        JSON.stringify({
          id: `${m[1]}-new`,
          content: body.content,
          createdAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
          authorName: "Ada",
        }),
        { status: 201 },
      );
    }
    if (m) return new Response(JSON.stringify(commentsFor(m[1])), { status: 200 });
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(cleanup);

function sheet(it: WorkItem, open = true) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CardDetailSheet
        item={it}
        open={open}
        onOpenChange={() => {}}
        orgId="o1"
        projectId="p1"
        members={[]}
        intervals={[]}
        columns={[{ key: "todo", name: "To Do" } as never]}
        onUpdate={() => {}}
      />
    </QueryClientProvider>
  );
}

/** Render the sheet and wait until every comment body is on screen. */
async function openWithComments(it: WorkItem = W1) {
  const utils = render(sheet(it));
  await waitFor(() => expect(screen.getAllByTestId("comment-body")).toHaveLength(COMMENTS));
  return utils;
}

const composer = () => screen.getByLabelText("Comment") as HTMLTextAreaElement;
const send = () => screen.getByRole("button", { name: "Add comment" });

/** Type `text` one character at a time, onto whatever the box already shows. */
function typeInto(el: HTMLTextAreaElement, text: string) {
  for (const ch of text) {
    fireEvent.change(el, { target: { value: el.value + ch } });
  }
}

describe("CardDetailSheet — typing a comment re-renders only the composer", () => {
  it("re-renders the comment list and the sheet zero times while typing", async () => {
    await openWithComments();
    // Positive control: the probes counted the list and the sheet rendering.
    expect(renders.markdown).toBeGreaterThanOrEqual(COMMENTS);
    expect(renders.sheet).toBeGreaterThan(0);

    renders.markdown = 0;
    renders.sheet = 0;
    typeInto(composer(), TYPED);

    // The typing reached the composer: its Send button woke up.
    expect(send()).toBeEnabled();
    expect(renders.markdown).toBe(0);
    expect(renders.sheet).toBe(0);
  });

  it("posts the typed text to THIS item, shows it, and clears the composer", async () => {
    await openWithComments();
    typeInto(composer(), `  ${TYPED}  `);
    renders.markdown = 0;
    await act(async () => {
      fireEvent.click(send());
    });

    await waitFor(() => expect(screen.getAllByTestId("comment-body")).toHaveLength(COMMENTS + 1));
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toMatch(/\/work-items\/W1\/comments$/);
    expect(posted[0].body.content).toBe(TYPED);
    expect(screen.getAllByTestId("comment-body").at(-1)?.textContent).toBe(TYPED);
    // A new comment DOES re-render the list: the same probe that read zero
    // above can see a real render.
    expect(renders.markdown).toBeGreaterThan(0);
    expect(composer().value).toBe("");
    expect(send()).toBeDisabled();
  });

  it("keeps the draft when the sheet is closed and the same item reopened", async () => {
    const { rerender } = await openWithComments();
    typeInto(composer(), TYPED);

    rerender(sheet(W1, false));
    await waitFor(() => expect(screen.queryByLabelText("Comment")).toBeNull());
    rerender(sheet(W1, true));

    await waitFor(() => expect(composer().value).toBe(TYPED));
    expect(send()).toBeEnabled();
  });

  it("keeps the draft across the Activity tab and back", async () => {
    await openWithComments();
    typeInto(composer(), TYPED);

    fireEvent.click(screen.getByRole("button", { name: /^Activity/ }));
    expect(screen.queryByLabelText("Comment")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Comments/ }));

    expect(composer().value).toBe(TYPED);
  });

  it("starts another item with an empty composer, so a draft is never posted to it", async () => {
    const { rerender } = await openWithComments(W1);
    typeInto(composer(), TYPED);
    expect(composer().value).toBe(TYPED);

    rerender(sheet(W2));
    await waitFor(() => expect(screen.getAllByTestId("comment-body")[0].textContent).toMatch(/^W2 /));

    expect(composer().value).toBe("");
    expect(send()).toBeDisabled();
    // One more keystroke on the new item carries none of the old draft.
    typeInto(composer(), "x");
    await act(async () => {
      fireEvent.click(send());
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].url).toMatch(/\/work-items\/W2\/comments$/);
    expect(posted[0].body.content).toBe("x");
  });

  it("does not bring the first item's draft back after visiting another item", async () => {
    const { rerender } = await openWithComments(W1);
    typeInto(composer(), TYPED);
    rerender(sheet(W2));
    await waitFor(() => expect(screen.getAllByTestId("comment-body")[0].textContent).toMatch(/^W2 /));
    rerender(sheet(W1));
    await waitFor(() => expect(screen.getAllByTestId("comment-body")[0].textContent).toMatch(/^W1 /));

    expect(composer().value).toBe("");
  });
});
