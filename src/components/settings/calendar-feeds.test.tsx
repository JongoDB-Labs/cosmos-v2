// @vitest-environment jsdom
// COSMOS-202: the calendar link UI. Off until an admin allows it; a new link is
// shown exactly once; the admin switch is only for people who manage integrations.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/settings/preferences", useParams: () => ({ orgSlug: "alpha" }) }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));

import { CalendarFeedsOrgSwitch, CalendarFeedsSection } from "./calendar-feeds";
import { jsonFetch } from "@/lib/query/json-fetcher";

const OPTS = { workItems: true, meetings: true, intervals: false, busyOnly: false };

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CalendarFeedsSection", () => {
  it("says feeds are off, and where an admin turns them on", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ enabled: false, canManage: true, feeds: [] } as never);
    wrap(<CalendarFeedsSection orgId="o1" />);
    expect(await screen.findByText(/hasn.t turned on calendar feeds/)).toBeTruthy();
    expect(screen.getByText(/Settings, Integrations/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Make a calendar link/ })).toBeNull();
  });

  it("shows a new link once, with a password warning, and never fetches it back", async () => {
    let feeds: unknown[] = [];
    vi.mocked(jsonFetch).mockImplementation((async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        feeds = [{ id: "f1", options: OPTS, createdAt: "2026-10-22T00:00:00Z", lastFetchedAt: null }];
        return { ...(feeds[0] as object), url: "https://example.com/api/v1/calendar/feeds/TOKEN.ics" };
      }
      return { enabled: true, canManage: false, feeds };
    }) as never);
    wrap(<CalendarFeedsSection orgId="o1" />);
    expect(await screen.findByText(/Treat the link like a password/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make a calendar link" }));
    const box = await screen.findByRole("status", { name: "New calendar link" });
    expect((box.querySelector("input") as HTMLInputElement).value).toBe("https://example.com/api/v1/calendar/feeds/TOKEN.ics");
    expect(box.textContent).toMatch(/won.t be shown again/);
    await waitFor(() => expect(screen.getByRole("group", { name: "Calendar link 1" })).toBeTruthy());
    // The list never carries a URL: only the create response did.
    expect(screen.getByRole("group", { name: "Calendar link 1" }).textContent).not.toMatch(/TOKEN/);
  });
});

describe("CalendarFeedsOrgSwitch", () => {
  it("is hidden from people who can't manage integrations", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ enabled: false, canManage: false, feeds: [] } as never);
    const { container } = wrap(<CalendarFeedsOrgSwitch orgId="o1" />);
    await waitFor(() => expect(jsonFetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("turns feeds on for an admin", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ enabled: false, canManage: true, feeds: [] } as never);
    wrap(<CalendarFeedsOrgSwitch orgId="o1" />);
    fireEvent.click(await screen.findByRole("switch", { name: "Allow calendar feed links" }));
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith(
        "/api/v1/orgs/o1/calendar-feeds/settings",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: true }) }),
      ),
    );
  });
});
