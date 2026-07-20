// @vitest-environment jsdom
//
// Foreman supervisor activity feed — mirrors the mocking idiom from
// foreman-supervisor-panel.test.tsx (mock next/navigation +
// @/lib/query/json-fetcher, wrap in a fresh QueryClientProvider per test):
// GET the grooming rows and render them newest-first. Also covers the
// Apply button on a dry row, which POSTs .../grooming/apply.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/foreman",
  useParams: () => ({ orgSlug: "acme" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

interface GroomingRow {
  id: string;
  ts: string;
  ticketKey: string | null;
  workItemId: string | null;
  action: string;
  evidence: string;
  dupOf: string | null;
  dry: boolean;
  prClosed: boolean | null;
}

function rows(): GroomingRow[] {
  return [
    {
      id: "g-1",
      ts: "2026-07-18T12:00:00.000Z",
      ticketKey: "COSMOS-88",
      workItemId: "wi-88",
      action: "escalate",
      evidence: "possible dup of COSMOS-29",
      dupOf: null,
      dry: true,
      prClosed: null,
    },
    {
      id: "g-2",
      ts: "2026-07-18T11:00:00.000Z",
      ticketKey: "COSMOS-12",
      workItemId: "wi-12",
      action: "deliver-close",
      evidence: "on main",
      dupOf: null,
      dry: false,
      prClosed: true,
    },
  ];
}

const holder: {
  calls: { url: string; method?: string; body?: unknown }[];
} = {
  calls: [],
};

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string, opts?: { method?: string; body?: string }) => {
    holder.calls.push({
      url,
      method: opts?.method,
      body: opts?.body ? JSON.parse(opts.body) : undefined,
    });
    if (opts?.method === "POST") {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ rows: rows() });
  }),
}));

import { ForemanGroomingFeed } from "./foreman-grooming-feed";

function renderFeed() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ForemanGroomingFeed orgId="org-1" />
    </QueryClientProvider>,
  );
}

describe("ForemanGroomingFeed", () => {
  afterEach(() => {
    cleanup();
    holder.calls.length = 0;
  });

  it("renders both ticket keys and evidence strings, and flags the dry row", async () => {
    renderFeed();

    expect(await screen.findByText("COSMOS-88")).toBeInTheDocument();
    expect(screen.getByText("COSMOS-12")).toBeInTheDocument();
    expect(screen.getByText("possible dup of COSMOS-29")).toBeInTheDocument();
    expect(screen.getByText("on main")).toBeInTheDocument();

    // The dry (escalate) row shows a "dry" indicator; the live row does not.
    expect(screen.getByText("dry")).toBeInTheDocument();
  });

  it('renders an "Apply" button on the dry row and clicking it POSTs the workItemId to grooming/apply', async () => {
    renderFeed();

    await screen.findByText("COSMOS-88");

    const applyButton = screen.getByRole("button", { name: /^apply$/i });
    fireEvent.click(applyButton);

    const applyUrl = "/api/v1/orgs/org-1/foreman/grooming/apply";
    await waitFor(() =>
      expect(holder.calls.some((c) => c.url === applyUrl && c.method === "POST")).toBe(true),
    );
    const call = holder.calls.find((c) => c.url === applyUrl && c.method === "POST");
    expect((call?.body as { workItemId: string }).workItemId).toBe("wi-88");
  });
});
