// @vitest-environment jsdom
//
// Foreman console — pulse pill mapping (alive/stale/paused/breaker) and the
// awaiting-approval Approve/Rebuild controls. `paused` is tested with `state: null`
// (daemon has never heartbeat) to exercise the fallback that derives the
// pill from the top-level `paused` flag when there's no live daemon state —
// the other three pills come straight from `state.pulse` as the API computes
// it (see pulseFor in @/lib/foreman/observe).
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ForemanStatusPayload } from "@/lib/foreman/status-read";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/foreman",
  useParams: () => ({ orgSlug: "acme" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { toast } from "sonner";

beforeAll(() => {
  // base-ui (Dialog/Button) needs these in jsdom — see
  // memory/testing-base-ui-in-jsdom.md.
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture || (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture || (() => {});
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture || (() => {});
});

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
    upNext: [],
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

const holder: {
  status: ForemanStatusPayload;
  calls: { url: string; method?: string; body?: unknown }[];
  recommendation: { recommendation: string; rationale: string; cached: boolean };
  analysis: {
    summary: string;
    criteria: { criterion: string; status: string; note: string }[];
    gaps: string[];
    risks: string[];
    complete: boolean;
    cached: boolean;
  };
} = {
  status: baseStatus(),
  calls: [],
  recommendation: { recommendation: "approve", rationale: "Diff matches the ticket and checks pass.", cached: false },
  analysis: {
    summary: "Covers the main criterion but the added test is thin.",
    criteria: [
      { criterion: "Creating a role with permissions succeeds", status: "met", note: "handled in the diff" },
      { criterion: "A regression test covers it", status: "partial", note: "asserts too little" },
    ],
    gaps: ["No docs update"],
    risks: ["Permission mask could overflow"],
    complete: false,
    cached: false,
  },
};

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string, opts?: { method?: string; body?: string }) => {
    holder.calls.push({
      url,
      method: opts?.method,
      body: opts?.body ? JSON.parse(opts.body) : undefined,
    });
    if (url.includes("/foreman/requirements-analysis")) {
      return Promise.resolve(holder.analysis);
    }
    if (url.includes("/foreman/approval-recommendation")) {
      return Promise.resolve(holder.recommendation);
    }
    if (url.includes("/foreman/events")) {
      return Promise.resolve({ events: [], nextCursor: null });
    }
    if (url.includes("/foreman/requeue")) {
      return Promise.resolve({ ok: true });
    }
    // The console also renders ForemanClaudePanel, which self-fetches its own
    // (differently-shaped) status — not connected here; see
    // foreman-claude-panel.test.tsx for that card's own behavior.
    if (url.includes("/foreman/claude-subscription/status")) {
      return Promise.resolve({ connected: false });
    }
    return Promise.resolve(holder.status);
  }),
}));

import { ForemanConsole } from "./foreman-console";

function renderConsole() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ForemanConsole orgId="org-1" />
    </QueryClientProvider>,
  );
}

describe("ForemanConsole — pulse pill", () => {
  afterEach(() => {
    cleanup();
    holder.calls.length = 0;
  });

  it('shows "Active" for an alive pulse', async () => {
    const s = baseStatus();
    holder.status = { ...s, state: { ...s.state!, pulse: "alive" } };
    renderConsole();
    expect(await screen.findByText("Active")).toBeInTheDocument();
  });

  it('shows "Stale — daemon not responding" for a stale pulse', async () => {
    const s = baseStatus();
    holder.status = { ...s, state: { ...s.state!, pulse: "stale" } };
    renderConsole();
    expect(await screen.findByText("Stale — daemon not responding")).toBeInTheDocument();
  });

  it('shows "Paused" from the top-level paused flag when there is no live daemon state', async () => {
    holder.status = baseStatus({
      state: null,
      paused: true,
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
    renderConsole();
    expect(await screen.findByText("Paused")).toBeInTheDocument();
  });

  it('shows "Circuit breaker" when the breaker is tripped', async () => {
    const s = baseStatus();
    holder.status = {
      ...s,
      state: { ...s.state!, pulse: "breaker", breaker: { build: 3, deploy: 0, tripped: true } },
    };
    renderConsole();
    expect(await screen.findByText("Circuit breaker")).toBeInTheDocument();
  });
});

describe("ForemanConsole — awaiting approval", () => {
  afterEach(() => {
    cleanup();
    holder.calls.length = 0;
  });

  function withOneParked() {
    holder.status = baseStatus({
      awaitingApproval: [
        {
          workItemId: "wi-1",
          projectId: "proj-1",
          ticketKey: "COSMOS-9",
          title: "Fix the flaky dedup test",
          reason: "Touches the auth boundary — flagged for review.",
          prUrl: "https://github.com/jongodb-labs/cosmos-v2/pull/123",
          parkedAt: new Date().toISOString(),
        },
      ],
    });
  }

  it("renders the AI recommendation badge + rationale on a PR-backed parked card, not the old static explainer", async () => {
    withOneParked();
    holder.recommendation = {
      recommendation: "approve",
      rationale: "Diff matches the ticket and checks pass.",
      cached: false,
    };
    renderConsole();

    expect(await screen.findByText("Fix the flaky dedup test")).toBeInTheDocument();
    // The AI recommendation (fetched per PR head SHA) replaces the old static
    // button-description paragraph (button semantics now live in tooltips/
    // confirmations from COSMOS-109).
    expect(await screen.findByText("Recommend: Approve")).toBeInTheDocument();
    expect(screen.getByText("Diff matches the ticket and checks pass.")).toBeInTheDocument();
    // The removed static explainer text must be gone.
    expect(screen.queryByText(/throws the current build away/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/resumes the existing\s+build/i)).not.toBeInTheDocument();
    // It fetched the recommendation endpoint for this item.
    await waitFor(() =>
      expect(
        holder.calls.some((c) => c.url.includes("/foreman/approval-recommendation?workItemId=wi-1")),
      ).toBe(true),
    );
  });

  it("recommends Rebuild (no request) on a card with no PR — nothing was built to approve", async () => {
    holder.status = baseStatus({
      awaitingApproval: [
        {
          workItemId: "wi-2",
          projectId: "proj-1",
          ticketKey: "COSMOS-10",
          title: "Agent feedback improvement",
          reason: "Agent produced no diff.",
          prUrl: null,
          parkedAt: new Date().toISOString(),
        },
      ],
    });
    renderConsole();

    expect(await screen.findByText("Agent feedback improvement")).toBeInTheDocument();
    expect(screen.getByText("Recommend: Rebuild")).toBeInTheDocument();
    // A no-PR card never calls the analysis endpoint.
    expect(holder.calls.some((c) => c.url.includes("/foreman/approval-recommendation"))).toBe(false);
  });

  it("clicking AI Analysis on a PR-backed card fetches + shows a per-criterion met/partial report with gaps/risks", async () => {
    withOneParked();
    renderConsole();

    expect(await screen.findByText("Fix the flaky dedup test")).toBeInTheDocument();

    // The report isn't fetched until the button is clicked (it's a paid call).
    expect(holder.calls.some((c) => c.url.includes("/foreman/requirements-analysis"))).toBe(false);
    const analysisButton = screen.getByRole("button", { name: /ai analysis/i });
    expect(analysisButton).toBeEnabled();
    fireEvent.click(analysisButton);

    // Per-criterion coverage: each criterion's text + its status label.
    expect(await screen.findByText("Creating a role with permissions succeeds")).toBeInTheDocument();
    expect(screen.getByText("Met")).toBeInTheDocument();
    expect(screen.getByText("Partial")).toBeInTheDocument();
    // Gaps + risks sections.
    expect(screen.getByText("No docs update")).toBeInTheDocument();
    expect(screen.getByText("Permission mask could overflow")).toBeInTheDocument();
    // It hit the analysis endpoint scoped to this item.
    await waitFor(() =>
      expect(
        holder.calls.some((c) => c.url.includes("/foreman/requirements-analysis?workItemId=wi-1")),
      ).toBe(true),
    );
  });

  it("disables AI Analysis on a no-PR card with an explanatory tooltip title (nothing to analyze)", async () => {
    holder.status = baseStatus({
      awaitingApproval: [
        {
          workItemId: "wi-2",
          projectId: "proj-1",
          ticketKey: "COSMOS-10",
          title: "Agent feedback improvement",
          reason: "Agent produced no diff.",
          prUrl: null,
          parkedAt: new Date().toISOString(),
        },
      ],
    });
    renderConsole();

    expect(await screen.findByText("Agent feedback improvement")).toBeInTheDocument();
    const analysisButton = screen.getByRole("button", { name: /ai analysis/i });
    expect(analysisButton).toBeDisabled();
    expect(analysisButton).toHaveAttribute(
      "title",
      "Nothing to analyze — the agent produced no pull request.",
    );
    // A disabled no-PR button never calls the analysis endpoint.
    expect(holder.calls.some((c) => c.url.includes("/foreman/requirements-analysis"))).toBe(false);
  });

  it("Approve opens a live-prod deploy confirmation, then POSTs an approve comment on confirm", async () => {
    withOneParked();
    renderConsole();

    expect(await screen.findByText("Fix the flaky dedup test")).toBeInTheDocument();

    // First click opens the confirmation Dialog (no POST yet) — the copy must
    // spell out that this deploys to live production.
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(
      await screen.findByText("Approve COSMOS-9 and deploy to live production?"),
    ).toBeInTheDocument();
    expect(screen.getByText(/waits\s+for the signed CI image/i)).toBeInTheDocument();

    const commentsUrl = "/api/v1/orgs/org-1/projects/proj-1/work-items/wi-1/comments";
    expect(holder.calls.some((c) => c.url === commentsUrl)).toBe(false);

    // Confirming in the dialog fires the POST.
    fireEvent.click(screen.getByRole("button", { name: /approve & deploy/i }));
    await waitFor(() => expect(holder.calls.some((c) => c.url === commentsUrl)).toBe(true));
    const call = holder.calls.find((c) => c.url === commentsUrl);
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({ content: "approve" });
  });

  it("hides Approve and Rebuild when the actor cannot steer (base-role gate), card stays read-only", async () => {
    holder.status = baseStatus({
      actorCanSteer: false,
      awaitingApproval: [
        {
          workItemId: "wi-1",
          projectId: "proj-1",
          ticketKey: "COSMOS-9",
          title: "Fix the flaky dedup test",
          reason: "Touches the auth boundary — flagged for review.",
          prUrl: "https://github.com/jongodb-labs/cosmos-v2/pull/123",
          parkedAt: new Date().toISOString(),
        },
      ],
    });
    renderConsole();

    // The card itself is still rendered (read-only) — reason + Link to PR.
    expect(await screen.findByText("Fix the flaky dedup test")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /link to pr/i })).toBeInTheDocument();
    // ...but the steering levers are gone.
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rebuild/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rework/i })).not.toBeInTheDocument();
  });

  it("Rebuild opens a from-scratch confirmation, then POSTs the requeue route on confirm", async () => {
    withOneParked();
    renderConsole();

    expect(await screen.findByText("Fix the flaky dedup test")).toBeInTheDocument();

    // First click opens the confirmation Dialog (no POST yet). The copy must
    // distinguish Rebuild (discard/start fresh) from Rework (resume existing).
    fireEvent.click(screen.getByRole("button", { name: /^rebuild$/i }));
    expect(
      await screen.findByText("Rebuild COSMOS-9 from scratch?"),
    ).toBeInTheDocument();
    expect(screen.getByText(/DISCARDS the current build/i)).toBeInTheDocument();
    expect(holder.calls.some((c) => c.url === "/api/v1/orgs/org-1/foreman/requeue")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /rebuild from scratch/i }));
    await waitFor(() =>
      expect(holder.calls.some((c) => c.url === "/api/v1/orgs/org-1/foreman/requeue")).toBe(true),
    );
    const call = holder.calls.find((c) => c.url === "/api/v1/orgs/org-1/foreman/requeue");
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({ workItemId: "wi-1" });
    expect(toast.success).toHaveBeenCalledWith("Rebuild queued — a fresh pass starts shortly.");
  });

  it('labels the PR link "Link to PR" (renamed from "Open PR")', async () => {
    withOneParked();
    renderConsole();

    expect(await screen.findByText("Fix the flaky dedup test")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /link to pr/i });
    expect(link).toHaveAttribute("href", "https://github.com/jongodb-labs/cosmos-v2/pull/123");
    expect(screen.queryByRole("link", { name: /^open pr$/i })).not.toBeInTheDocument();
  });

  it("renders Approve button disabled when card has no prUrl", async () => {
    holder.status = baseStatus({
      awaitingApproval: [
        {
          workItemId: "wi-2",
          projectId: "proj-1",
          ticketKey: "COSMOS-10",
          title: "Agent feedback improvement",
          reason: "Clarity suggestions — needs review.",
          prUrl: null,
          parkedAt: new Date().toISOString(),
        },
      ],
    });
    renderConsole();

    expect(await screen.findByText("Agent feedback improvement")).toBeInTheDocument();
    const approveButton = screen.getByRole("button", { name: /approve/i });
    expect(approveButton).toBeDisabled();
    expect(approveButton).toHaveAttribute(
      "title",
      "Nothing built yet — comment instructions on the ticket or Rebuild",
    );
    // Rework has no prUrl gate — instructions can be sent before anything's built.
    expect(screen.getByRole("button", { name: /rework/i })).toBeEnabled();
  });
});

describe("ForemanConsole — Up next", () => {
  afterEach(() => {
    cleanup();
    holder.calls.length = 0;
  });

  it("renders a row per queued ticket: ticket-key link, title, why, and age; muted dash when why is null", async () => {
    holder.status = baseStatus({
      upNext: [
        {
          workItemId: "wi-20",
          projectId: "proj-1",
          ticketKey: "COSMOS-20",
          title: "Tighten the dedup window",
          why: "Highest open ROI — top vote count",
          since: new Date(Date.now() - 3 * 3600_000).toISOString(),
        },
        {
          workItemId: "wi-21",
          projectId: "proj-1",
          ticketKey: "COSMOS-21",
          title: "Human-added todo ticket",
          why: null,
          since: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    renderConsole();

    expect(await screen.findByText("Up next")).toBeInTheDocument();
    expect(screen.getByText("Tighten the dedup window")).toBeInTheDocument();
    expect(screen.getByText("Highest open ROI — top vote count")).toBeInTheDocument();
    expect(screen.getByText("3h ago")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "COSMOS-20" });
    expect(link).toHaveAttribute("href", "/acme/issues?item=wi-20");

    // Human-added todo item (Foreman never planned it): why renders as "—", not blank.
    const humanRow = screen.getByText("Human-added todo ticket").closest("tr");
    const whyCell = humanRow?.querySelectorAll("td")[2];
    expect(whyCell).toHaveTextContent("—");
  });

  it("shows the empty state when nothing is planned", async () => {
    holder.status = baseStatus({ upNext: [] });
    renderConsole();

    expect(
      await screen.findByText(
        "Nothing planned yet — Foreman promotes the highest-priority backlog tickets here.",
      ),
    ).toBeInTheDocument();
  });
});

describe("ForemanConsole — Rework dialog", () => {
  afterEach(() => {
    cleanup();
    holder.calls.length = 0;
  });

  function withOneParked() {
    holder.status = baseStatus({
      awaitingApproval: [
        {
          workItemId: "wi-1",
          projectId: "proj-1",
          ticketKey: "COSMOS-9",
          title: "Fix the flaky dedup test",
          reason: "Touches the auth boundary — flagged for review.",
          prUrl: "https://github.com/jongodb-labs/cosmos-v2/pull/123",
          parkedAt: new Date().toISOString(),
        },
      ],
    });
  }

  it("opens with the ticket key in the title and keeps Send disabled until real text is entered", async () => {
    withOneParked();
    renderConsole();

    expect(await screen.findByText("Fix the flaky dedup test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /rework/i }));

    expect(await screen.findByText("Rework COSMOS-9")).toBeInTheDocument();
    const sendButton = screen.getByRole("button", { name: /send to foreman/i });
    expect(sendButton).toBeDisabled();

    const textarea = screen.getByPlaceholderText("What should change?");
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(sendButton).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "Also handle the retry case" } });
    expect(sendButton).toBeEnabled();
  });

  it("Send posts the typed instructions to the ticket's comments route and toasts", async () => {
    withOneParked();
    renderConsole();

    expect(await screen.findByText("Fix the flaky dedup test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /rework/i }));
    expect(await screen.findByText("Rework COSMOS-9")).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText("What should change?");
    fireEvent.change(textarea, { target: { value: "Also handle the retry case" } });
    fireEvent.click(screen.getByRole("button", { name: /send to foreman/i }));

    const commentsUrl = "/api/v1/orgs/org-1/projects/proj-1/work-items/wi-1/comments";
    await waitFor(() => expect(holder.calls.some((c) => c.url === commentsUrl)).toBe(true));
    const call = holder.calls.find((c) => c.url === commentsUrl);
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({ content: "Also handle the retry case" });
    expect(toast.success).toHaveBeenCalledWith("Sent — Foreman picks it up on its next pass (≤1 min)");
  });

  it("resets the textarea across tickets — typed text for one ticket doesn't leak into the next", async () => {
    holder.status = baseStatus({
      awaitingApproval: [
        {
          workItemId: "wi-1",
          projectId: "proj-1",
          ticketKey: "COSMOS-9",
          title: "Fix the flaky dedup test",
          reason: "Touches the auth boundary — flagged for review.",
          prUrl: "https://github.com/jongodb-labs/cosmos-v2/pull/123",
          parkedAt: new Date().toISOString(),
        },
        {
          workItemId: "wi-2",
          projectId: "proj-1",
          ticketKey: "COSMOS-10",
          title: "Agent feedback improvement",
          reason: "Clarity suggestions — needs review.",
          prUrl: "https://github.com/jongodb-labs/cosmos-v2/pull/124",
          parkedAt: new Date().toISOString(),
        },
      ],
    });
    renderConsole();

    expect(await screen.findByText("Fix the flaky dedup test")).toBeInTheDocument();
    const reworkButtons = screen.getAllByRole("button", { name: /rework/i });
    expect(reworkButtons).toHaveLength(2);

    // Open for ticket A, type, cancel without sending.
    fireEvent.click(reworkButtons[0]);
    expect(await screen.findByText("Rework COSMOS-9")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("What should change?"), {
      target: { value: "Notes meant only for COSMOS-9" },
    });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    // Open for ticket B — the single shared dialog must not carry A's text over.
    fireEvent.click(reworkButtons[1]);
    expect(await screen.findByText("Rework COSMOS-10")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("What should change?")).toHaveValue("");
  });
});
