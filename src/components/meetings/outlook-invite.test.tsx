// @vitest-environment jsdom
// COSMOS-202 B2 invite mode: the meeting's "Outlook invitations" section stays
// out of the way when the org has Outlook off, says why it can't be turned on,
// shows who would be invited (and who is outside the org) before anything is
// sent, and says plainly what happened when invitations ended.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/meetings/m1", useParams: () => ({ orgSlug: "alpha" }) }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));

import { OutlookInvitePanel } from "./outlook-invite";
import { jsonFetch } from "@/lib/query/json-fetcher";

const URL = "/api/v1/orgs/o1/meetings/m1/outlook-invite";
const state = (over: object) => ({
  available: true, on: false, organizerId: null, organizerName: null, canChange: true, reason: null,
  recipients: [{ name: "Bob", email: "bob@contoso.example", outside: false }], domains: ["contoso.example"], ended: null, pendingCancel: false,
  ...over,
});
function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
const loaded = () => waitFor(() => expect(jsonFetch).toHaveBeenCalledWith(URL));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OutlookInvitePanel", () => {
  it("shows nothing while the org has Outlook Calendar off", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(state({ available: false }) as never);
    const { container } = wrap(<OutlookInvitePanel orgId="o1" meetingId="m1" />);
    await loaded();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("reviews the recipients, flags those outside the org, then sends", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(
      state({
        recipients: [
          { name: "Bob", email: "bob@contoso.example", outside: false },
          { name: "Eve", email: "eve@partner.example", outside: true },
        ],
      }) as never,
    );
    wrap(<OutlookInvitePanel orgId="o1" meetingId="m1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Send Outlook invitations" }));
    const review = screen.getByRole("group", { name: "Send Outlook invitations" });
    expect(review.textContent).toContain("bob@contoso.example");
    expect(review.textContent).toContain("eve@partner.example");
    expect(screen.getByRole("alert").textContent).toMatch(/1 attendee is outside your\s+organization's domains \(contoso\.example\)/);
    expect(jsonFetch).not.toHaveBeenCalledWith(URL, expect.objectContaining({ method: "PUT" }));
    fireEvent.click(screen.getByRole("button", { name: "Send invitations" }));
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith(URL, expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: true }) })),
    );
  });

  it("can't be turned on for a classified meeting, and says why", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(state({ canChange: false, reason: "classified" }) as never);
    wrap(<OutlookInvitePanel orgId="o1" meetingId="m1" />);
    const btn = await screen.findByRole("button", { name: "Send Outlook invitations" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Classified meetings can't send Outlook invitations/)).toBeTruthy();
  });

  it("points someone not connected at their Outlook settings", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(state({ canChange: false, reason: "not_connected" }) as never);
    wrap(<OutlookInvitePanel orgId="o1" meetingId="m1" />);
    const link = await screen.findByRole("link", { name: "Outlook Calendar settings" });
    expect(link.getAttribute("href")).toBe("/alpha/settings/preferences");
  });

  it("while on, says who sends them; the organizer can stop them after a warning", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(state({ on: true, organizerId: "u1", organizerName: "Alice" }) as never);
    wrap(<OutlookInvitePanel orgId="o1" meetingId="m1" />);
    expect((await screen.findByText("Alice")).tagName).toBe("STRONG");
    fireEvent.click(screen.getByRole("button", { name: "Stop sending invitations" }));
    expect(screen.getByRole("group", { name: "Stop Outlook invitations" }).textContent).toContain("sent a cancellation");
    fireEvent.click(screen.getByRole("button", { name: "Cancel the invitations" }));
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith(URL, expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: false }) })),
    );
  });

  it("someone who can't edit sees who sends them, with no way to stop them", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(state({ on: true, organizerId: "u1", organizerName: "Alice", canChange: false }) as never);
    wrap(<OutlookInvitePanel orgId="o1" meetingId="m1" />);
    await screen.findByText("Alice");
    expect(screen.queryByRole("button", { name: "Stop sending invitations" })).toBeNull();
  });

  it("says plainly when invitations were left in Outlook and are no longer updated, even with Outlook now off", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(
      state({ available: false, ended: { how: "released", reason: "organizer_disconnected", at: "2026-10-23T00:00:00Z" } }) as never,
    );
    wrap(<OutlookInvitePanel orgId="o1" meetingId="m1" />);
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("left in Outlook when their organizer disconnected Outlook Calendar");
    expect(note.textContent).toContain("Cosmos no longer updates them");
    expect(screen.queryByRole("button", { name: "Send Outlook invitations" })).toBeNull();
  });

  it("says when invitations were cancelled, and why", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(
      state({ ended: { how: "cancelled", reason: "organizer_left", at: "2026-10-23T00:00:00Z" } }) as never,
    );
    wrap(<OutlookInvitePanel orgId="o1" meetingId="m1" />);
    expect((await screen.findByRole("note")).textContent).toContain("cancelled because their organizer left the organization");
  });
  it("a cancellation waiting on a reconnect says so, and offers no second stop", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(state({ on: true, organizerId: "u1", organizerName: "Alice", canChange: true, pendingCancel: true }) as never);
    wrap(<OutlookInvitePanel orgId="o1" meetingId="m1" />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't be cancelled: reconnect your Outlook Calendar/);
    expect(screen.queryByRole("button", { name: "Stop sending invitations" })).toBeNull();
  });

  it("a live invitation can be stopped by its organizer", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(state({ on: true, organizerId: "u1", organizerName: "Alice", canChange: true }) as never);
    wrap(<OutlookInvitePanel orgId="o1" meetingId="m1" />);
    expect(await screen.findByRole("button", { name: "Stop sending invitations" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keyboard focus follows the review: into it when it opens, back to its button when put away", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(state({}) as never);
    wrap(<OutlookInvitePanel orgId="o1" meetingId="m1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Send Outlook invitations" }));
    const review = screen.getByRole("group", { name: "Send Outlook invitations" });
    await waitFor(() => expect(document.activeElement).toBe(review));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send Outlook invitations" })));
  });

  it("the stop confirmation takes focus, and gives it back to Stop", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(state({ on: true, organizerId: "u1", organizerName: "Alice", canChange: true }) as never);
    wrap(<OutlookInvitePanel orgId="o1" meetingId="m1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop sending invitations" }));
    const confirm = screen.getByRole("group", { name: "Stop Outlook invitations" });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    fireEvent.click(screen.getByRole("button", { name: "Keep sending" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop sending invitations" })));
  });

  it("once a change goes through, focus lands on the section heading", async () => {
    let on = false;
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => {
      if (init?.method === "PUT") on = true;
      return state(on ? { on: true, organizerId: "u1", organizerName: "Alice" } : {}) as never;
    });
    wrap(<OutlookInvitePanel orgId="o1" meetingId="m1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Send Outlook invitations" }));
    fireEvent.click(screen.getByRole("button", { name: "Send invitations" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Outlook invitations" })));
  });

});
