// @vitest-environment jsdom
//
// Foreman supervisor activity feed — mirrors the mocking idiom from
// foreman-supervisor-panel.test.tsx (mock next/navigation +
// @/lib/query/json-fetcher, wrap in a fresh QueryClientProvider per test):
// GET the grooming rows and render them newest-first.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/foreman",
  useParams: () => ({ orgSlug: "acme" }),
}));

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

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn(() => Promise.resolve({ rows: rows() })),
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
});
