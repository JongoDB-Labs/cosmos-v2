// @vitest-environment jsdom
//
// The discussion on a feedback item (feedback discussion, Phase 1).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  can: vi.fn<(p: bigint) => boolean>(() => true),
  handlers: {} as Record<string, (d: unknown) => void>,
  jsonFetch: vi.fn(),
}));
vi.mock("@/components/providers/permissions-provider", async (orig) => ({
  ...(await orig<typeof import("@/components/providers/permissions-provider")>()),
  usePermissions: () => ({ can: h.can }),
}));
vi.mock("@/hooks/use-realtime-events", () => ({
  useRealtimeEvents: (_o: string, handlers: Record<string, (d: unknown) => void>) => {
    Object.assign(h.handlers, handlers);
  },
}));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: h.jsonFetch }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/components/chat/mention-typeahead", () => ({ useOrgMembers: () => ({ data: [] }) }));
vi.mock("@/components/mentions/hooks", () => ({ useRefResolver: () => new Map() }));
vi.mock("@/components/chat/markdown-content", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("@/components/notes/editor/rich-text-editor", () => ({
  NoteRichTextEditor: ({ ariaLabel, onChange, initialMarkdown }: { ariaLabel: string; onChange: (v: string) => void; initialMarkdown: string }) => (
    <textarea aria-label={ariaLabel} defaultValue={initialMarkdown} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { Permission } from "@/lib/rbac/permissions";
import { FeedbackThread, MAKE_INTERNAL_CONFIRM, RAISE_MARKING_CONFIRM, type FeedbackComment } from "./feedback-thread";

const c = (over: Partial<FeedbackComment>): FeedbackComment => ({
  id: "c1",
  parentId: null,
  kind: "COMMENT",
  visibility: "PUBLIC",
  classification: null,
  content: "Would love this",
  deleted: false,
  author: { id: "u1", displayName: "Carol", avatarUrl: null },
  createdAt: "2026-10-23T10:00:00.000Z",
  editedAt: null,
  revisionCount: 0,
  canEdit: false,
  canDelete: false,
  replies: [],
  ...over,
});

let thread: FeedbackComment[] = [];
let marking: { orgCeiling: string } | null = null;
const BASE = "/api/v1/orgs/o1/feedback/f1/comments";
const POLICY = "/api/v1/orgs/o1/feedback/comment-policy";

function renderThread(item: Record<string, unknown> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FeedbackThread orgId="o1" item={{ id: "f1", ...item }} />
    </QueryClientProvider>,
  );
}
const gets = () => h.jsonFetch.mock.calls.filter(([u, init]) => u === BASE && !init).length;

beforeEach(() => {
  h.can.mockImplementation(() => true);
  h.handlers = {};
  marking = null;
  h.jsonFetch.mockReset();
  h.jsonFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === BASE && !init) return thread;
    if (url === POLICY) return { marking };
    if (url.endsWith("/revisions")) return [{ id: "r1", content: "Would like this", redacted: false, editedBy: { displayName: "Carol" }, createdAt: "2026-10-23T09:00:00.000Z" }];
    return {};
  });
  window.history.replaceState(null, "", "/o/feedback");
});
afterEach(cleanup);

describe("FeedbackThread", () => {
  it("shows comments with their replies", async () => {
    thread = [c({ replies: [c({ id: "c2", parentId: "c1", content: "Same here", author: { id: "u2", displayName: "Bob", avatarUrl: null } })] })];
    renderThread();
    expect(await screen.findByText("Would love this")).toBeInTheDocument();
    expect(screen.getByText("Same here")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Discussion" }).textContent).toContain("Discussion (2)");
  });

  it("keeps a deleted comment's replies under a tombstone, without its words", async () => {
    thread = [c({ deleted: true, content: null, author: null, replies: [c({ id: "c2", parentId: "c1", content: "Same here" })] })];
    renderThread();
    expect(await screen.findByText("This comment was deleted.")).toBeInTheDocument();
    expect(screen.getByText("Same here")).toBeInTheDocument();
  });

  it("posts a comment", async () => {
    thread = [];
    renderThread();
    fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "Night shifts need this" } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() =>
      expect(h.jsonFetch).toHaveBeenCalledWith(BASE, { method: "POST", body: JSON.stringify({ content: "Night shifts need this" }) }),
    );
  });

  it("replies under the comment it answers", async () => {
    thread = [c({})];
    renderThread();
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "+1" } });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() =>
      expect(h.jsonFetch).toHaveBeenCalledWith(BASE, { method: "POST", body: JSON.stringify({ content: "+1", parentId: "c1" }) }),
    );
  });

  it("gives a VIEWER a composer only on their own request", async () => {
    thread = [];
    h.can.mockImplementation((p: bigint) => p !== Permission.COMMENT_CREATE && p !== Permission.ORG_UPDATE);
    renderThread();
    await screen.findByText(/No comments yet/);
    expect(screen.queryByLabelText("Comment")).toBeNull();
    cleanup();
    renderThread({ isMine: true });
    expect(await screen.findByLabelText("Comment")).toBeInTheDocument();
  });

  it("closes a locked thread to members and a merged one to everyone", async () => {
    thread = [];
    h.can.mockImplementation((p: bigint) => p !== Permission.ORG_UPDATE);
    renderThread({ lockedAt: "2026-10-23T00:00:00.000Z" });
    expect(await screen.findByText("Comments are closed on this request.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Comment")).toBeNull();
    cleanup();
    h.can.mockImplementation(() => true);
    renderThread({ mergedIntoId: "f9" });
    expect(await screen.findByText(/This request was merged/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Comment")).toBeNull();
  });

  it("stays closed for a merged request whose survivor was deleted (no pointer)", async () => {
    thread = [];
    renderThread({ status: "MERGED", mergedIntoId: null });
    expect(await screen.findByText(/This request was merged/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Comment")).toBeNull();
  });

  it("refetches when someone comments on this item, and only this item", async () => {
    thread = [];
    renderThread();
    await screen.findByText(/No comments yet/);
    const before = gets();
    await act(async () => h.handlers["feedback.comment.created"]({ feedbackId: "other" }));
    expect(gets()).toBe(before);
    await act(async () => h.handlers["feedback.comment.created"]({ feedbackId: "f1" }));
    await waitFor(() => expect(gets()).toBe(before + 1));
  });

  it("opens an edited comment's history", async () => {
    thread = [c({ editedAt: "2026-10-23T11:00:00.000Z", revisionCount: 1 })];
    renderThread();
    fireEvent.click(await screen.findByRole("button", { name: "Edit history" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit history" });
    expect(await within(dialog).findByText("Would like this")).toBeInTheDocument();
  });

  it("marks the comment a #c- link points at", async () => {
    thread = [c({}), c({ id: "c9", content: "the one" })];
    window.history.replaceState(null, "", "/o/feedback#c-c9");
    renderThread();
    await screen.findByText("the one");
    await waitFor(() => expect(document.getElementById("c-c9")?.className).toContain("ring-amber"));
    expect(document.getElementById("c-c1")?.className).not.toContain("ring-amber");
  });

  describe("team voice", () => {
    const posted = () =>
      h.jsonFetch.mock.calls
        .filter(([u, init]) => u === BASE && init?.method === "POST")
        .map(([, init]) => JSON.parse(String(init.body)));
    const patched = () =>
      h.jsonFetch.mock.calls
        .filter(([, init]) => init?.method === "PATCH")
        .map(([u, init]) => [u, JSON.parse(String(init.body))]);
    beforeEach(() => {
      try {
        window.localStorage.removeItem("cosmos:feedback-composer-tab");
      } catch {
        /* jsdom */
      }
    });

    it("lets staff post an internal note, says who will see it, and remembers the tab", async () => {
      thread = [];
      renderThread();
      fireEvent.click(await screen.findByRole("tab", { name: "Internal note" }));
      expect(screen.getByText("Only the feedback team will see this")).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Internal note"), { target: { value: "Check with eng" } });
      fireEvent.click(screen.getByRole("button", { name: "Post internal note" }));
      await waitFor(() => expect(posted()).toEqual([{ content: "Check with eng", visibility: "INTERNAL" }]));

      cleanup();
      renderThread();
      expect(await screen.findByRole("tab", { name: "Internal note" })).toHaveAttribute("aria-selected", "true");
    });

    it("lets staff post the official response", async () => {
      thread = [];
      renderThread();
      fireEvent.click(await screen.findByLabelText("Post as the official response"));
      fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Planned for Q1" } });
      fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
      await waitFor(() => expect(posted()).toEqual([{ content: "Planned for Q1", kind: "OFFICIAL" }]));
    });

    it("pins the official response first and marks internal notes", async () => {
      thread = [
        c({ id: "a", content: "first" }),
        c({ id: "n", content: "a note", visibility: "INTERNAL" }),
        c({ id: "o", content: "the answer", kind: "OFFICIAL" }),
      ];
      renderThread();
      await screen.findByText("the answer");
      const order = [...document.querySelectorAll('[id^="c-"]')].map((e) => e.id);
      expect(order).toEqual(["c-o", "c-a", "c-n"]);
      expect(within(document.getElementById("c-o")!).getByText("Official response")).toBeInTheDocument();
      expect(within(document.getElementById("c-n")!).getByText("Internal")).toBeInTheDocument();
      expect(within(document.getElementById("c-a")!).queryByText("Internal")).toBeNull();
    });

    it("lets staff pin a comment, move it between public and internal, and filter", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      thread = [c({ id: "a", content: "public one" }), c({ id: "n", content: "a note", visibility: "INTERNAL" })];
      renderThread();
      await screen.findByText("public one");
      fireEvent.click(screen.getAllByRole("button", { name: "Mark as official response" })[0]);
      fireEvent.click(screen.getAllByRole("button", { name: "Make internal" })[0]);
      fireEvent.click(screen.getByRole("button", { name: "Make public" }));
      await waitFor(() =>
        expect(patched()).toEqual([
          [`${BASE}/a`, { official: true }],
          [`${BASE}/a`, { visibility: "INTERNAL" }],
          [`${BASE}/n`, { visibility: "PUBLIC" }],
        ]),
      );
      // Only going internal asks first.
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith(MAKE_INTERNAL_CONFIRM);
      confirm.mockRestore();
      fireEvent.click(screen.getByRole("button", { name: "Internal" }));
      expect(screen.queryByText("public one")).toBeNull();
      expect(screen.getByText("a note")).toBeInTheDocument();
    });

    it("warns before making a comment internal that delivered alerts stay, and backs off on cancel", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      thread = [c({ id: "a", content: "public one" })];
      renderThread();
      await screen.findByText("public one");
      fireEvent.click(screen.getByRole("button", { name: "Make internal" }));
      expect(confirm.mock.calls[0][0]).toMatch(/can't be recalled/);
      expect(patched()).toEqual([]);
      confirm.mockRestore();
    });

    describe("markings (gov tenant)", () => {
      it("keeps a CUI post internal when the org isn't cleared for CUI, and says so", async () => {
        marking = { orgCeiling: "UNCLASSIFIED" };
        thread = [];
        renderThread();
        const picker = await screen.findByLabelText("Marking");
        expect(screen.getByLabelText("Post as the official response")).toBeInTheDocument();
        fireEvent.change(picker, { target: { value: "CUI" } });
        expect(screen.getByText("Marked CUI: only the feedback team will see this")).toBeInTheDocument();
        expect(screen.queryByLabelText("Post as the official response")).toBeNull();
        fireEvent.change(screen.getByLabelText("Internal note"), { target: { value: "Unit 4 affected" } });
        fireEvent.click(screen.getByRole("button", { name: "Post internal note" }));
        await waitFor(() =>
          expect(posted()).toEqual([{ content: "Unit 4 affected", visibility: "INTERNAL", classification: "CUI" }]),
        );
        await waitFor(() => expect(screen.getByLabelText("Marking")).toHaveValue(""));
      });

      it("lets a CUI comment stay public once the org ceiling covers it", async () => {
        marking = { orgCeiling: "CUI" };
        thread = [];
        renderThread();
        fireEvent.change(await screen.findByLabelText("Marking"), { target: { value: "CUI" } });
        expect(screen.queryByText(/only the feedback team will see this/)).toBeNull();
        fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Fixed in the CUI enclave" } });
        fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
        await waitFor(() => expect(posted()).toEqual([{ content: "Fixed in the CUI enclave", classification: "CUI" }]));
      });

      it("offers only the markings this org may hold", async () => {
        marking = { orgCeiling: "UNCLASSIFIED" };
        thread = [];
        renderThread();
        const opts = [...(await screen.findByLabelText("Marking")).querySelectorAll("option")].map((o) => o.textContent);
        expect(opts).toEqual(["No marking", "Public", "Unclassified", "CUI"]);

        cleanup();
        marking = { orgCeiling: "CONFIDENTIAL" };
        renderThread();
        const all = [...(await screen.findByLabelText("Marking")).querySelectorAll("option")].map((o) => o.textContent);
        expect(all).toContain("Confidential");
      });

      it("changes a comment's marking, warning first when that takes it internal", async () => {
        marking = { orgCeiling: "UNCLASSIFIED" };
        thread = [c({ id: "a", content: "public one" }), c({ id: "n", content: "a note", visibility: "INTERNAL", classification: "CUI" })];
        const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
        renderThread();
        await screen.findByText("public one");
        const [pub, note] = screen.getAllByLabelText("Change marking");
        fireEvent.change(pub, { target: { value: "CUI" } });
        expect(confirm).toHaveBeenCalledWith(RAISE_MARKING_CONFIRM);
        expect(patched()).toEqual([]);

        confirm.mockReturnValue(true);
        fireEvent.change(pub, { target: { value: "CUI" } });
        // Lowering, or marking an internal note, asks nothing.
        confirm.mockClear();
        fireEvent.change(note, { target: { value: "" } });
        fireEvent.change(pub, { target: { value: "UNCLASSIFIED" } });
        expect(confirm).not.toHaveBeenCalled();
        await waitFor(() =>
          expect(patched()).toEqual([
            [`${BASE}/a`, { classification: "CUI" }],
            [`${BASE}/n`, { classification: null }],
            [`${BASE}/a`, { classification: "UNCLASSIFIED" }],
          ]),
        );
        confirm.mockRestore();
      });

      it("shows a comment's marking", async () => {
        thread = [c({ id: "m", content: "marked one", classification: "CUI" })];
        renderThread();
        await screen.findByText("marked one");
        expect(within(document.getElementById("c-m")!).getByLabelText("Marked CUI")).toHaveTextContent("CUI");
      });

      it("offers no picker outside a gov tenant, and never asks for members", async () => {
        thread = [c({ id: "a", content: "public one" })];
        renderThread();
        await screen.findByText("public one");
        expect(screen.queryByLabelText("Marking")).toBeNull();
        expect(screen.queryByLabelText("Change marking")).toBeNull();

        cleanup();
        h.jsonFetch.mockClear();
        marking = { orgCeiling: "UNCLASSIFIED" };
        h.can.mockImplementation((p: bigint) => p !== Permission.ORG_UPDATE);
        renderThread();
        await screen.findByLabelText("Comment");
        expect(screen.queryByLabelText("Marking")).toBeNull();
        expect(screen.queryByLabelText("Change marking")).toBeNull();
        expect(h.jsonFetch.mock.calls.some(([u]) => u === POLICY)).toBe(false);
      });
    });

    it("shows none of it to members", async () => {
      h.can.mockImplementation((p: bigint) => p !== Permission.ORG_UPDATE);
      thread = [c({ id: "a", content: "public one" })];
      renderThread();
      await screen.findByText("public one");
      expect(screen.queryByRole("tab", { name: "Internal note" })).toBeNull();
      expect(screen.queryByLabelText("Post as the official response")).toBeNull();
      expect(screen.queryByRole("button", { name: "Mark as official response" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Make internal" })).toBeNull();
      expect(screen.queryByRole("group", { name: "Show comments" })).toBeNull();
    });
  });
});
