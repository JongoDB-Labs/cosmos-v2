// @vitest-environment jsdom
//
// Foreman build-harness settings card — mirrors the mocking idiom from
// foreman-supervisor-panel.test.tsx (mock next/navigation + sonner +
// @/lib/errors/notify + @/lib/query/json-fetcher, wrap in a fresh
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

interface HarnessSettings {
  enabled: boolean;
  systemPromptAppend: string | null;
}

function defaultSettings(): HarnessSettings {
  return { enabled: true, systemPromptAppend: null };
}

const holder: {
  settings: HarnessSettings;
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
      holder.settings = JSON.parse(opts.body as string) as HarnessSettings;
      return Promise.resolve(holder.settings);
    }
    return Promise.resolve(holder.settings);
  }),
}));

import { ForemanHarnessPanel } from "./foreman-harness-panel";

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ForemanHarnessPanel orgId="org-1" />
    </QueryClientProvider>,
  );
}

describe("ForemanHarnessPanel", () => {
  afterEach(() => {
    cleanup();
    holder.calls.length = 0;
    holder.settings = defaultSettings();
  });

  it("renders the Enabled toggle checked when settings load enabled:true", async () => {
    renderPanel();
    const enabledCheckbox = await screen.findByRole("checkbox", { name: /enabled/i });
    expect(enabledCheckbox).toBeChecked();
  });

  it("toggling Enabled off and clicking Save issues a PUT carrying the changed value", async () => {
    renderPanel();
    const enabledCheckbox = await screen.findByRole("checkbox", { name: /enabled/i });
    expect(enabledCheckbox).toBeChecked();

    fireEvent.click(enabledCheckbox);
    expect(enabledCheckbox).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    const putUrl = "/api/v1/orgs/org-1/foreman/harness";
    await waitFor(() =>
      expect(holder.calls.some((c) => c.url === putUrl && c.method === "PUT")).toBe(true),
    );
    const call = holder.calls.find((c) => c.url === putUrl && c.method === "PUT");
    expect((call?.body as HarnessSettings).enabled).toBe(false);
    expect((call?.body as HarnessSettings).systemPromptAppend).toBeNull();
  });

  it("editing the system-prompt append and clicking Save issues a PUT carrying the new text", async () => {
    renderPanel();
    const textarea = await screen.findByLabelText(/system-prompt append/i);

    fireEvent.change(textarea, { target: { value: "Always run lint before committing." } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    const putUrl = "/api/v1/orgs/org-1/foreman/harness";
    await waitFor(() =>
      expect(holder.calls.some((c) => c.url === putUrl && c.method === "PUT")).toBe(true),
    );
    const call = holder.calls.find((c) => c.url === putUrl && c.method === "PUT");
    expect((call?.body as HarnessSettings).systemPromptAppend).toBe(
      "Always run lint before committing.",
    );
    expect((call?.body as HarnessSettings).enabled).toBe(true);
  });
});
