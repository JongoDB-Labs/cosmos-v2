// @vitest-environment jsdom
// COSMOS-202 (B1, B2): the Outlook calendar section shows exactly one next step for
// each state: off for the org, not connected, connected, or reconnect needed.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/settings/preferences", useParams: () => ({ orgSlug: "alpha" }) }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/query/json-fetcher", async (orig) => ({
  ...(await orig<typeof import("@/lib/query/json-fetcher")>()),
  jsonFetch: vi.fn(),
}));

import { OutlookCalendarAdminSetup, OutlookCalendarSection } from "./outlook-calendar";
import { FetchError, jsonFetch } from "@/lib/query/json-fetcher";

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

  it("asks what happens to sent invitations before disconnecting, and says plainly what Keep means", async () => {
    const conn = status({ connection: { account: "a@contoso.example", status: "connected", connectedAt: "2026-10-23T00:00:00Z", lastSyncAt: null } });
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method !== "DELETE") return conn as never;
      if (String(url).endsWith("/calendar")) throw new FetchError(409, { error: "Choose", liveInvites: 2 }, "Choose");
      return {} as never;
    });
    wrap(<OutlookCalendarSection orgId="o1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const choice = await screen.findByRole("group", { name: "Your Outlook invitations" });
    expect(choice.textContent).toContain("2 upcoming meetings");
    expect(choice.textContent).toContain("the invitations stay in Outlook, but Cosmos will no longer update them");
    const { notifyError } = await import("@/lib/errors/notify");
    expect(notifyError).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep invitations and disconnect" }));
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/o1/microsoft/calendar?invites=keep", expect.objectContaining({ method: "DELETE" })),
    );
    await waitFor(() => expect(screen.queryByRole("group", { name: "Your Outlook invitations" })).toBeNull());
  });

  it("cancels sent invitations when asked to, and can back out", async () => {
    const conn = status({ connection: { account: "a@contoso.example", status: "connected", connectedAt: "2026-10-23T00:00:00Z", lastSyncAt: null } });
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method !== "DELETE") return conn as never;
      if (String(url).endsWith("/calendar")) throw new FetchError(409, { error: "Choose", liveInvites: 1 }, "Choose");
      return {} as never;
    });
    wrap(<OutlookCalendarSection orgId="o1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect((await screen.findByRole("group", { name: "Your Outlook invitations" })).textContent).toContain("1 upcoming meeting.");
    fireEvent.click(screen.getByRole("button", { name: "Don't disconnect" }));
    expect(screen.queryByRole("group", { name: "Your Outlook invitations" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel invitations and disconnect" }));
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/o1/microsoft/calendar?invites=cancel", expect.objectContaining({ method: "DELETE" })),
    );
  });

  it("keyboard focus follows the disconnect steps instead of falling to the page", async () => {
    const conn = status({ connection: { account: "a@contoso.example", status: "connected", connectedAt: "2026-10-23T00:00:00Z", lastSyncAt: null } });
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method !== "DELETE") return conn as never;
      throw new FetchError(409, { error: "Choose", liveInvites: 1 }, "Choose");
    });
    wrap(<OutlookCalendarSection orgId="o1" />);
    const disconnect = await screen.findByRole("button", { name: "Disconnect" });
    disconnect.focus();
    fireEvent.click(disconnect);
    const choice = await screen.findByRole("group", { name: "Your Outlook invitations" });
    await waitFor(() => expect(document.activeElement).toBe(choice));
    fireEvent.click(screen.getByRole("button", { name: "Don't disconnect" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Disconnect" })));
  });

  it("after disconnecting, focus moves to Connect", async () => {
    const conn = status({ connection: { account: "a@contoso.example", status: "connected", connectedAt: "2026-10-23T00:00:00Z", lastSyncAt: null } });
    let connected = true;
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => {
      if (init?.method === "DELETE") {
        connected = false;
        return {} as never;
      }
      return (connected ? conn : status({})) as never;
    });
    wrap(<OutlookCalendarSection orgId="o1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const connect = await screen.findByRole("link", { name: "Connect Outlook Calendar" });
    await waitFor(() => expect(document.activeElement).toBe(connect));
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
