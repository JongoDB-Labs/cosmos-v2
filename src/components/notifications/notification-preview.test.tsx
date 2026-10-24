// @vitest-environment jsdom
//
// COSMOS-217: hovering a notification previews it — the whole message, when,
// and for a work item the item as it is now, read through the access-checked
// row endpoint (so nothing the person couldn't open), fetched only on open.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/inbox" }));

import { NotificationPreview, type PreviewableNotification } from "./notification-preview";

const ITEM = {
  id: "w1", ticketNumber: 7, ticketKey: "FSC-7", title: "Fix the export", columnKey: "in_progress",
  priority: "HIGH", type: { id: "t", key: "bug", name: "Bug", icon: null, color: null },
  project: { id: "p", key: "FSC", name: "Core" },
  assignee: null, assignees: [{ id: "u", displayName: "Dana", avatarUrl: null }],
  parent: null, intervalId: null, storyPoints: null, tags: [], highlight: null, archivedAt: null,
  startDate: null, dueDate: "2026-11-02T00:00:00.000Z", completedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
};

const fetchSpy = vi.fn();
beforeEach(() => {
  fetchSpy.mockReset().mockImplementation(async () => new Response(JSON.stringify(ITEM), { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mention: PreviewableNotification = {
  type: "comment.mentioned",
  title: "Mentioned in Fix the export",
  body: "Can you take a look at the CSV header? The second line wraps and the third one is the one I mean.",
  refType: "work_item",
  refId: "w1",
  createdAt: "2026-10-24T09:30:00.000Z",
};

function renderPreview(n: PreviewableNotification) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NotificationPreview orgId="o1" notification={n}>
        <div>row: {n.title}</div>
      </NotificationPreview>
    </QueryClientProvider>,
  );
  return screen.getByText(`row: ${n.title}`);
}

async function open(row: HTMLElement) {
  fireEvent.focus(row);
  fireEvent.pointerEnter(row, { pointerType: "mouse" });
  fireEvent.mouseEnter(row);
  return await screen.findByTestId("notification-preview", {}, { timeout: 2000 });
}

describe("NotificationPreview", () => {
  it("fetches nothing until it opens", async () => {
    renderPreview(mention);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the whole message and the item as it is now", async () => {
    const popup = await open(renderPreview(mention));
    expect(within(popup).getByText(mention.body)).toBeInTheDocument();
    expect(await within(popup).findByText("Fix the export")).toBeInTheDocument();
    expect(within(popup).getByText("FSC-7 · Bug")).toBeInTheDocument();
    expect(within(popup).getByText("In progress")).toBeInTheDocument();
    expect(within(popup).getByText("High")).toBeInTheDocument();
    expect(within(popup).getByText("Dana")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith("/api/v1/orgs/o1/work-items/w1/row", expect.anything());
  });

  it("says so, and shows nothing of the item, when it can't be read", async () => {
    fetchSpy.mockImplementation(async () => new Response(null, { status: 404 }));
    const popup = await open(renderPreview(mention));
    expect(
      await within(popup).findByText("You can’t see this item, or it has been deleted."),
    ).toBeInTheDocument();
    expect(within(popup).queryByText("FSC-7 · Bug")).toBeNull();
  });

  it("asks for no item when the notification isn't about one", async () => {
    const popup = await open(renderPreview({ ...mention, refType: "timesheet", refId: "t1", title: "Timesheet approved" }));
    expect(within(popup).getByText(mention.body)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
