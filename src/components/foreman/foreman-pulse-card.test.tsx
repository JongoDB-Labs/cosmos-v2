// @vitest-environment jsdom
//
// Foreman pulse card — the compact dashboard status strip. It self-fetches
// (no Suspense wrapper) and renders nothing until there's something worth
// showing: either autonomous delivery is enabled for this org, or it has run
// here before. See foreman-console.test.tsx for the mocking idiom this
// mirrors (mock next/navigation + @/lib/query/json-fetcher, wrap in a fresh
// QueryClientProvider per test).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ForemanStatusPayload } from "@/lib/foreman/status-read";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme",
  useParams: () => ({ orgSlug: "acme" }),
}));

function baseStatus(overrides: Partial<ForemanStatusPayload> = {}): ForemanStatusPayload {
  return {
    state: {
      pulse: "alive",
      lastPassAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      daemonVersion: "1.9.0",
      workerTarget: 2,
      slotsBusy: 1,
      queueDepth: 0,
      breaker: { build: 0, deploy: 0, tripped: false },
      stopFileSeen: false,
    },
    paused: false,
    inFlight: [],
    awaitingApproval: [],
    config: {
      autoRemediation: { enabled: false, projectIds: [], defaultProjectId: null },
      autonomousDelivery: {
        enabled: true,
        projectIds: ["p1"],
        notify: { parked: true, shipped: true },
        workers: 2,
      },
    },
    hasHistory: true,
    actorCanSteer: true,
    ...overrides,
  };
}

// Shipped-events fixture the card's second query resolves to; only the
// fields the card reads (ts, data.version) are typed here.
const holder: {
  status: ForemanStatusPayload;
  events: { ts: string; data: { version?: string } | null }[];
} = {
  status: baseStatus(),
  events: [],
};

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.includes("/foreman/events")) {
      return Promise.resolve({ events: holder.events, nextCursor: null });
    }
    return Promise.resolve(holder.status);
  }),
}));

import { ForemanPulseCard } from "./foreman-pulse-card";

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ForemanPulseCard orgId="org-1" />
    </QueryClientProvider>,
  );
}

describe("ForemanPulseCard", () => {
  afterEach(() => {
    cleanup();
    holder.status = baseStatus();
    holder.events = [];
  });

  it("renders nothing when delivery is disabled and there's no history", async () => {
    holder.status = baseStatus({
      hasHistory: false,
      config: {
        autoRemediation: { enabled: false, projectIds: [], defaultProjectId: null },
        autonomousDelivery: {
          enabled: false,
          projectIds: [],
          notify: { parked: true, shipped: true },
          workers: 2,
        },
      },
    });
    const { container } = renderCard();
    // Nothing ever renders in this case, so there's no element to await —
    // yield a tick so the query has settled before asserting the empty state
    // (otherwise we'd only be proving the loading state, also null, is null).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows in-flight/awaiting counts and the latest shipped version", async () => {
    holder.status = baseStatus({
      inFlight: [
        {
          key: "COSMOS-1",
          itemId: "wi-1",
          orgId: "org-1",
          title: "Fix the flaky dedup test",
          phase: "building",
          since: new Date().toISOString(),
        },
        {
          key: "COSMOS-2",
          itemId: "wi-2",
          orgId: "org-1",
          title: "Add retry to the webhook sender",
          phase: "checks",
          since: new Date().toISOString(),
        },
      ],
      awaitingApproval: [1, 2, 3].map((n) => ({
        workItemId: `wi-a${n}`,
        projectId: "p1",
        ticketKey: `COSMOS-${n}`,
        title: `Item ${n}`,
        reason: null,
        prUrl: null,
        parkedAt: new Date().toISOString(),
      })),
    });
    holder.events = [{ ts: new Date().toISOString(), data: { version: "2.183.0" } }];

    renderCard();

    expect(await screen.findByText(/2 building/)).toBeInTheDocument();
    expect(screen.getByText(/3 awaiting approval/)).toBeInTheDocument();
    // The shipped fragment comes from a second query that only starts once
    // the first has resolved, so it lands a render cycle later — findByText
    // (which polls) rather than getByText.
    expect(await screen.findByText(/v2\.183\.0/)).toBeInTheDocument();
  });

  it('marks the status dot data-pulse="stale" for a stale pulse', async () => {
    const s = baseStatus();
    holder.status = { ...s, state: { ...s.state!, pulse: "stale" } };

    const { container } = renderCard();

    await screen.findByText(/building/);
    expect(container.querySelector('[data-pulse="stale"]')).toBeInTheDocument();
  });
});
