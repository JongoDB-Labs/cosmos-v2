// @vitest-environment jsdom
//
// Per-ticket supervisor badge — mirrors the mocking idiom from
// foreman-grooming-feed.test.tsx (mock @/lib/query/json-fetcher and
// @/lib/errors/notify). Unlike the feed, this component uses plain
// jsonFetch + useState/useEffect (not react-query) so it works wherever
// CardDetailSheet mounts, without needing a QueryClientProvider ancestor —
// so no provider wrapper here either.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

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

const holder: {
  calls: { url: string; method?: string; body?: unknown }[];
  rows: GroomingRow[];
} = {
  calls: [],
  rows: [],
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
    return Promise.resolve({ rows: holder.rows });
  }),
}));

import { ForemanGroomingBadge } from "./foreman-grooming-badge";

describe("ForemanGroomingBadge", () => {
  afterEach(() => {
    cleanup();
    holder.calls.length = 0;
    holder.rows = [];
  });

  it("renders an Apply button for a dry deliver-close row and POSTs the workItemId on click", async () => {
    holder.rows = [
      {
        id: "g-1",
        ts: "2026-07-18T12:00:00.000Z",
        ticketKey: "COSMOS-88",
        workItemId: "wi-88",
        action: "deliver-close",
        evidence: "on main",
        dupOf: null,
        dry: true,
        prClosed: null,
      },
    ];

    render(<ForemanGroomingBadge orgId="org-1" workItemId="wi-88" />);

    expect(await screen.findByText("Supervisor:")).toBeInTheDocument();
    expect(screen.getByText("Deliver & close")).toBeInTheDocument();
    expect(screen.getByText("dry")).toBeInTheDocument();

    const applyButton = screen.getByRole("button", { name: /^apply$/i });
    fireEvent.click(applyButton);

    const applyUrl = "/api/v1/orgs/org-1/foreman/grooming/apply";
    await waitFor(() =>
      expect(holder.calls.some((c) => c.url === applyUrl && c.method === "POST")).toBe(true),
    );
    const call = holder.calls.find((c) => c.url === applyUrl && c.method === "POST");
    expect((call?.body as { workItemId: string }).workItemId).toBe("wi-88");
  });

  it("renders nothing when there are no rows", async () => {
    holder.rows = [];

    const { container } = render(<ForemanGroomingBadge orgId="org-1" workItemId="wi-88" />);

    // Give the fetch a tick to resolve; there should never be any content.
    await waitFor(() => expect(holder.calls.length).toBeGreaterThan(0));
    expect(container).toBeEmptyDOMElement();
  });
});
