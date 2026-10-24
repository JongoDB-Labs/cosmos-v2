// @vitest-environment jsdom
// COSMOS-202 T1: the Cosmos for Teams setup card stays away until Outlook
// Calendar is set up, then lists what to do in order, with the bot's app id,
// the messaging endpoint and the package download.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/settings/integrations", useParams: () => ({ orgSlug: "alpha" }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));

import { TeamsAppSetup } from "./teams-app-setup";
import { jsonFetch } from "@/lib/query/json-fetcher";

const status = (over: object) => ({
  installed: false, calendarReady: true, appId: "app-123", messagingEndpoint: "https://cosmos.example/api/teams/bot",
  publicUrlConfigured: true, appIdUri: "api://cosmos.example/app-123", ...over,
});
function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TeamsAppSetup", () => {
  it("shows nothing until Outlook Calendar is set up", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(status({ calendarReady: false }) as never);
    const { container } = wrap(<TeamsAppSetup orgId="o1" />);
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/o1/microsoft/teams-app"));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("gives the bot's app id, the messaging endpoint and the package to upload", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(status({}) as never);
    wrap(<TeamsAppSetup orgId="o1" />);
    expect(await screen.findByText("app-123")).toBeTruthy();
    expect(screen.getByText("https://cosmos.example/api/teams/bot")).toBeTruthy();
    expect(screen.getByText(/Install "Cosmos for Teams" below/)).toBeTruthy();
    // Tab sign-in: the Expose an API step, with the URI and Teams' two client ids.
    expect(screen.getByText("api://cosmos.example/app-123")).toBeTruthy();
    expect(screen.getByText("1fec8e78-bce4-4aaf-ab1b-5451cc387264")).toBeTruthy();
    expect(screen.getByText("5e3ce6c0-2b1f-4285-8d4b-75ee78787346")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download app package" }).getAttribute("href")).toBe("/api/v1/orgs/o1/microsoft/teams-app/package");
  });

  it("without COSMOS_PUBLIC_URL, says the tabs need it, and offers no App ID URI", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(status({ publicUrlConfigured: false, appIdUri: null }) as never);
    wrap(<TeamsAppSetup orgId="o1" />);
    expect(await screen.findByText("COSMOS_PUBLIC_URL")).toBeTruthy();
    expect(screen.queryByText(/^api:\/\//)).toBeNull();
  });

  it("without the Microsoft sign-in app, says to configure it first and offers no package", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(status({ appId: null, installed: true }) as never);
    wrap(<TeamsAppSetup orgId="o1" />);
    expect(await screen.findByText(/Configure the Microsoft sign-in app first/)).toBeTruthy();
    expect(screen.getByText("Cosmos for Teams is installed.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download app package" })).toBeNull();
  });
});
