// @vitest-environment jsdom
// COSMOS-202: the sharing level for what Cosmos publishes into Outlook — a
// person's own on Preferences, the org-wide default on Integrations. Each
// control names the level it is on and saves the one picked.
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
// base-ui's Select is a button plus a portalled popup, which cannot be driven
// in jsdom: a native <select> exercises the component's own state logic, as the
// work-item select suites do.
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children, disabled }: {
    value: string; onValueChange: (v: string) => void; children?: React.ReactNode; disabled?: boolean;
  }) => (
    <select value={value} disabled={disabled} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  // Dropped, so the native <select> below is the only control in the tree:
  // in the real component this is the button that carries the accessible name.
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => <option value={value}>{children}</option>,
}));

import { OutlookCalendarAdminSetup, OutlookCalendarSection } from "./outlook-calendar";
import { jsonFetch } from "@/lib/query/json-fetcher";

const CONNECTED = { account: "a@contoso.example", status: "connected" as const, connectedAt: "2026-10-23T00:00:00Z", lastSyncAt: null };
const status = (over: object) => ({ enabled: true, canManage: false, admin: null, connection: null, ...over });

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a person's own sharing level", () => {
  it("names the org default it inherits, and saves a level picked instead", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(
      status({ connection: CONNECTED, sharing: { level: "default", orgDefault: "busy", effective: "busy" } }) as never,
    );
    wrap(<OutlookCalendarSection orgId="o1" />);
    expect(await screen.findByText("What your Cosmos calendar shows")).toBeTruthy();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("default");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Organization default (free/busy only)",
      "Full details",
      "Free/busy only",
    ]);
    // On free/busy only, it says what that means rather than implying titles go out.
    expect(screen.getByText(/go out as plain busy blocks/)).toBeTruthy();

    fireEvent.change(select, { target: { value: "full" } });
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/o1/microsoft/calendar/sharing", {
        method: "PUT",
        body: JSON.stringify({ level: "full" }),
      }),
    );
  });

  it("isn't offered to someone who hasn't connected a calendar", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(
      status({ sharing: { level: "default", orgDefault: "full", effective: "full" } }) as never,
    );
    wrap(<OutlookCalendarSection orgId="o1" />);
    await screen.findByRole("link", { name: "Connect Outlook Calendar" });
    expect(screen.queryByText("What your Cosmos calendar shows")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

describe("the org-wide default", () => {
  const admin = { redirectUri: "https://c.example/cb", adminConsentUrl: null, appConfigured: true };

  it("shows the current default to an admin, and saves a new one", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(
      status({ canManage: true, admin, sharing: { level: "default", orgDefault: "full", effective: "full" } }) as never,
    );
    wrap(<OutlookCalendarAdminSetup orgId="o1" />);
    expect(await screen.findByText("What published calendars show by default")).toBeTruthy();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("full");
    // A default, not a ceiling: it says so.
    expect(screen.getByText(/Each person can still choose their own/)).toBeTruthy();

    fireEvent.change(select, { target: { value: "busy" } });
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/o1/microsoft/calendar/sharing", {
        method: "PUT",
        body: JSON.stringify({ orgDefault: "busy" }),
      }),
    );
  });

  it("is not shown to someone who can't manage integrations", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(
      status({ canManage: false, admin: null, sharing: { level: "default", orgDefault: "full", effective: "full" } }) as never,
    );
    wrap(<OutlookCalendarAdminSetup orgId="o1" />);
    await waitFor(() => expect(jsonFetch).toHaveBeenCalled());
    expect(screen.queryByText("What published calendars show by default")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
