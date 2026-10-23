// @vitest-environment jsdom
// COSMOS-202 (B1, B2): the Outlook calendar section shows exactly one next step for
// each state: off for the org, not connected, connected, or reconnect needed.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/settings/preferences", useParams: () => ({ orgSlug: "alpha" }) }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));

import { OutlookCalendarAdminSetup, OutlookCalendarSection } from "./outlook-calendar";
import { jsonFetch } from "@/lib/query/json-fetcher";

const status = (over: object) => ({ enabled: true, canManage: false, admin: null, connection: null, ...over });
function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("OutlookCalendarSection", () => {
  it("says the org hasn't turned it on, with no Connect", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(status({ enabled: false }) as never);
    wrap(<OutlookCalendarSection orgId="o1" />);
    expect(await screen.findByText(/hasn.t turned on Outlook Calendar/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Connect/ })).toBeNull();
  });

  it("offers Connect, pointing at the org's connect route", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(status({}) as never);
    wrap(<OutlookCalendarSection orgId="o1" />);
    const link = await screen.findByRole("link", { name: "Connect Outlook Calendar" });
    expect(link.getAttribute("href")).toBe("/api/v1/orgs/o1/microsoft/calendar/connect");
  });

  it("shows the connected account, and disconnects", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(
      status({ connection: { account: "a@contoso.example", status: "connected", connectedAt: "2026-10-23T00:00:00Z", lastSyncAt: null } }) as never,
    );
    wrap(<OutlookCalendarSection orgId="o1" />);
    expect(await screen.findByText("a@contoso.example")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Reconnect" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/o1/microsoft/calendar", expect.objectContaining({ method: "DELETE" })),
    );
  });

  it("shows when it last synced, and syncs now on request", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(
      status({
        connection: { account: "a@contoso.example", status: "connected", connectedAt: "2026-10-23T00:00:00Z", lastSyncAt: "2026-10-23T12:00:00Z" },
      }) as never,
    );
    wrap(<OutlookCalendarSection orgId="o1" />);
    expect((await screen.findByText(/Last synced/)).textContent).toContain(new Date("2026-10-23T12:00:00Z").toLocaleString());
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/o1/microsoft/calendar/sync", expect.objectContaining({ method: "POST" })),
    );
  });

  it("says when it hasn't synced yet, and offers no Sync now while a reconnect is needed", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(
      status({ connection: { account: "a@contoso.example", status: "reconnect", connectedAt: "2026-10-23T00:00:00Z", lastSyncAt: null } }) as never,
    );
    wrap(<OutlookCalendarSection orgId="o1" />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  });

  it("asks to reconnect when Microsoft stopped accepting the connection", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(
      status({ connection: { account: "a@contoso.example", status: "reconnect", connectedAt: "2026-10-23T00:00:00Z", lastSyncAt: null } }) as never,
    );
    wrap(<OutlookCalendarSection orgId="o1" />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/stopped accepting/);
    expect(screen.getByRole("link", { name: "Reconnect" }).getAttribute("href")).toBe("/api/v1/orgs/o1/microsoft/calendar/connect");
  });

  it("explains the round trip's outcome in words", async () => {
    window.history.replaceState(null, "", "/alpha/settings/preferences?outlook=wrong_tenant");
    vi.mocked(jsonFetch).mockResolvedValue(status({}) as never);
    wrap(<OutlookCalendarSection orgId="o1" />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/different organization/);
  });
});

describe("OutlookCalendarAdminSetup", () => {
  it("is hidden from people who can't manage integrations", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(status({}) as never);
    const { container } = wrap(<OutlookCalendarAdminSetup orgId="o1" />);
    await waitFor(() => expect(jsonFetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("shows admins the redirect URI and the consent link", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(
      status({
        canManage: true,
        admin: { redirectUri: "https://x/api/v1/microsoft/calendar/callback", adminConsentUrl: "https://login/consent", appConfigured: true },
      }) as never,
    );
    wrap(<OutlookCalendarAdminSetup orgId="o1" />);
    expect(await screen.findByText("https://x/api/v1/microsoft/calendar/callback")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Grant admin consent" }).getAttribute("href")).toBe("https://login/consent");
  });
});
