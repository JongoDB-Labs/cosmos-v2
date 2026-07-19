// @vitest-environment jsdom
//
// Foreman supervisor settings card — mirrors the mocking idiom from
// foreman-claude-panel.test.tsx / foreman-pulse-card.test.tsx (mock
// next/navigation + @/lib/query/json-fetcher, wrap in a fresh
// QueryClientProvider per test): GET current settings, PUT the full object
// back on Save.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/foreman",
  useParams: () => ({ orgSlug: "acme" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

interface SupervisorSettings {
  mode: "off" | "dry" | "live";
  deliverClose: boolean;
  requeue: boolean;
  dedup: boolean;
  escalate: boolean;
  confidenceThreshold: number;
  perPassCap: number;
}

function defaultSettings(): SupervisorSettings {
  return {
    mode: "dry",
    deliverClose: true,
    requeue: true,
    dedup: true,
    escalate: true,
    confidenceThreshold: 0.8,
    perPassCap: 5,
  };
}

const holder: {
  settings: SupervisorSettings;
  calls: { url: string; method?: string; body?: unknown }[];
} = {
  settings: defaultSettings(),
  calls: [],
};

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string, opts?: { method?: string; body?: string }) => {
    holder.calls.push({
      url,
      method: opts?.method,
      body: opts?.body ? JSON.parse(opts.body) : undefined,
    });
    if (opts?.method === "PUT") {
      holder.settings = JSON.parse(opts.body as string) as SupervisorSettings;
      return Promise.resolve(holder.settings);
    }
    return Promise.resolve(holder.settings);
  }),
}));

import { ForemanSupervisorPanel } from "./foreman-supervisor-panel";

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ForemanSupervisorPanel orgId="org-1" />
    </QueryClientProvider>,
  );
}

describe("ForemanSupervisorPanel", () => {
  afterEach(() => {
    cleanup();
    holder.calls.length = 0;
    holder.settings = defaultSettings();
  });

  it('renders the mode control reflecting "dry"', async () => {
    renderPanel();
    const dryButton = await screen.findByRole("button", { name: /dry/i });
    expect(dryButton).toHaveAttribute("aria-pressed", "true");
    const liveButton = screen.getByRole("button", { name: /live/i });
    expect(liveButton).toHaveAttribute("aria-pressed", "false");
    const offButton = screen.getByRole("button", { name: /off/i });
    expect(offButton).toHaveAttribute("aria-pressed", "false");
  });

  it("toggling a behavior checkbox and clicking Save issues a PUT carrying the changed value", async () => {
    renderPanel();
    const requeueCheckbox = await screen.findByRole("checkbox", { name: /requeue/i });
    expect(requeueCheckbox).toBeChecked();

    fireEvent.click(requeueCheckbox);
    expect(requeueCheckbox).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    const putUrl = "/api/v1/orgs/org-1/foreman/supervisor";
    await waitFor(() =>
      expect(holder.calls.some((c) => c.url === putUrl && c.method === "PUT")).toBe(true),
    );
    const call = holder.calls.find((c) => c.url === putUrl && c.method === "PUT");
    expect((call?.body as SupervisorSettings).requeue).toBe(false);
    // The rest of the payload rides along unchanged.
    expect((call?.body as SupervisorSettings).mode).toBe("dry");
    expect((call?.body as SupervisorSettings).deliverClose).toBe(true);
  });
});
