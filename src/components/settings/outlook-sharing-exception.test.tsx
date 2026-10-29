// @vitest-environment jsdom
// COSMOS-202 review fix: free/busy only is not an absolute promise about the
// "Cosmos" calendar — a meeting whose Outlook invitations the person sends
// themselves is their own Outlook event and keeps its title and links. Both
// places that offer the choice must SAY that rather than promise more than
// they deliver. And since the resync shares "Sync now"'s budget, saving says
// which actually happened: updating now, or catching up at the next sync.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/settings/preferences", useParams: () => ({ orgSlug: "alpha" }) }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/query/json-fetcher", async (orig) => ({
  ...(await orig<typeof import("@/lib/query/json-fetcher")>()),
  jsonFetch: vi.fn(),
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children, disabled }: {
    value: string; onValueChange: (v: string) => void; children?: React.ReactNode; disabled?: boolean;
  }) => (
    <select value={value} disabled={disabled} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => <option value={value}>{children}</option>,
}));

import { OutlookCalendarAdminSetup, OutlookCalendarSection } from "./outlook-calendar";
import { jsonFetch } from "@/lib/query/json-fetcher";

const CONNECTED = { account: "a@contoso.example", status: "connected" as const, connectedAt: "2026-10-23T00:00:00Z", lastSyncAt: null };
const status = (over: object) => ({ enabled: true, canManage: false, admin: null, connection: null, ...over });
const ADMIN = { redirectUri: "https://c.example/cb", adminConsentUrl: null, appConfigured: true };

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** GET answers `state`; the PUT answers `put`. */
function serve(state: object, put: object = { resyncNow: true }) {
  vi.mocked(jsonFetch).mockImplementation((async (_url: string, init?: { method?: string }) =>
    init?.method === "PUT" ? put : state) as never);
}

describe("what free/busy only actually promises", () => {
  it("tells someone on free/busy only that an invitation they send keeps its title and links", async () => {
    serve(status({ connection: CONNECTED, sharing: { level: "busy", orgDefault: "full", effective: "busy" } }));
    wrap(<OutlookCalendarSection orgId="o1" />);
    const copy = await screen.findByText(/plain busy blocks/);
    // The promise is qualified where it is made, not somewhere else.
    expect(copy.textContent).toMatch(/invitations you send yourself/);
    expect(copy.textContent).toMatch(/keeps its title, details and links/);
    // And it says who can then see them: the point of choosing free/busy only.
    expect(copy.textContent).toMatch(/anyone you share the calendar with/i);
  });

  it("tells the admin setting the default the same thing", async () => {
    serve(status({ canManage: true, admin: ADMIN, sharing: { level: "default", orgDefault: "busy", effective: "busy" } }));
    wrap(<OutlookCalendarAdminSetup orgId="o1" />);
    const copy = await screen.findByText(/no titles, details or links/);
    expect(copy.textContent).toMatch(/invitations someone sends themselves still carries its details/);
  });
});

describe("saying whether Outlook is updating now", () => {
  const connectedBusy = () => status({ connection: CONNECTED, sharing: { level: "default", orgDefault: "full", effective: "full" } });

  it("promises an immediate update only when the server actually started one", async () => {
    serve(connectedBusy(), { resyncNow: true });
    wrap(<OutlookCalendarSection orgId="o1" />);
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "busy" } });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Saved. Your Cosmos calendar is being updated."));
  });

  it("says it catches up later when the shared sync budget was spent", async () => {
    serve(connectedBusy(), { resyncNow: false });
    wrap(<OutlookCalendarSection orgId="o1" />);
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "busy" } });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved. Your Cosmos calendar will catch up within a few minutes."),
    );
  });
});
