// @vitest-environment jsdom
// COSMOS-202 T2: choosing which Cosmos notifications come to your Teams chat.
// Hidden while the org has no Cosmos for Teams; until you've opened the chat,
// it says how; then one switch per type, each saving the whole choice.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/settings/preferences", useParams: () => ({ orgSlug: "alpha" }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));

import { TeamsNotificationsSection } from "./teams-notifications";
import { jsonFetch } from "@/lib/query/json-fetcher";

const URL = "/api/v1/orgs/o1/microsoft/teams-app/notifications";
function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TeamsNotificationsSection", () => {
  it("shows nothing when the org hasn't Cosmos for Teams", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ available: false, chatReady: false, notifyTypes: [] } as never);
    const { container } = wrap(<TeamsNotificationsSection orgId="o1" />);
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledWith(URL));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("before the chat exists, says how to open it, with no switches", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ available: true, chatReady: false, notifyTypes: [] } as never);
    wrap(<TeamsNotificationsSection orgId="o1" />);
    expect(await screen.findByText(/Open Cosmos in Teams/)).toBeTruthy();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("a switch per type, showing what's chosen; turning one on saves the whole choice", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ available: true, chatReady: true, notifyTypes: ["mentioned"] } as never);
    wrap(<TeamsNotificationsSection orgId="o1" />);
    const assigned = await screen.findByRole("switch", { name: "An item is assigned to me" });
    expect(assigned.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "I'm mentioned in a comment" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(assigned);
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith(URL, { method: "PUT", body: JSON.stringify({ notifyTypes: ["assigned", "mentioned"] }) }),
    );
  });

  it("turning one off keeps the others", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ available: true, chatReady: true, notifyTypes: ["assigned", "due_tomorrow"] } as never);
    wrap(<TeamsNotificationsSection orgId="o1" />);
    fireEvent.click(await screen.findByRole("switch", { name: "An item is assigned to me" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledWith(URL, { method: "PUT", body: JSON.stringify({ notifyTypes: ["due_tomorrow"] }) }));
  });
});
