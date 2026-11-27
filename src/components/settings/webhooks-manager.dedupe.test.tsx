// @vitest-environment jsdom
//
// Each webhook row used to carry two controls for the same four operations: the
// inline icon buttons plus a DataTable ⋯ "Row actions" menu repeating Edit /
// Send test / Activate / Delete. The Status cell and the create/edit forms were
// copies too — of ToggleSwitch and of each other.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/alpha/settings/webhooks",
  useParams: () => ({ orgSlug: "alpha" }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", async (orig) => ({
  ...(await orig<typeof import("@/lib/query/json-fetcher")>()),
  jsonFetch: vi.fn(),
}));

import { WebhooksManager } from "./webhooks-manager";
import { jsonFetch } from "@/lib/query/json-fetcher";

const HOOK = {
  id: "w1", orgId: "o1", url: "https://hooks.example.com/a", events: ["work_item.created"],
  active: false, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
    if (String(url) === "/api/v1/orgs/o1/webhooks" && !init?.method) return [HOOK] as never;
    return HOOK as never;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("WebhooksManager — one control per operation", () => {
  it("offers no second ⋯ menu beside the inline row actions", async () => {
    wrap(<WebhooksManager orgId="o1" />);
    await screen.findByTitle("Edit");

    expect(screen.queryByRole("button", { name: "Row actions" })).toBeNull();
    // The operations are still reachable, once each.
    expect(screen.getAllByTitle("Edit")).toHaveLength(1);
    expect(screen.getAllByTitle("Send test")).toHaveLength(1);
    expect(screen.getAllByTitle("Delete")).toHaveLength(1);
    expect(screen.getAllByRole("switch", { name: "Toggle https://hooks.example.com/a" })).toHaveLength(1);
  });

  it("gives the Status switch a visible OFF track and a focus ring", async () => {
    wrap(<WebhooksManager orgId="o1" />);
    const sw = await screen.findByRole("switch", { name: "Toggle https://hooks.example.com/a" });

    expect(sw.getAttribute("aria-checked")).toBe("false");
    // bg-muted ≈ the card surface, which is the invisible pill ToggleSwitch fixed.
    expect(sw.className).not.toContain("bg-muted");
    expect(sw.className).toContain("focus-visible:ring-2");
  });

  it("the Edit dialog is the shared form, prefilled, and saves", async () => {
    wrap(<WebhooksManager orgId="o1" />);
    fireEvent.click(await screen.findByTitle("Edit"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit Webhook")).toBeTruthy();
    expect(
      (within(dialog).getByPlaceholderText("https://example.com/webhook") as HTMLInputElement).value,
    ).toBe("https://hooks.example.com/a");
    // Its subscribed event comes through checked, and keeps the edit dialog's own ids.
    expect(within(dialog).getByLabelText("work_item.created")).toBeTruthy();
    expect(dialog.querySelector("#edit-events-label")).not.toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith(
        "/api/v1/orgs/o1/webhooks/w1",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
  });
});
