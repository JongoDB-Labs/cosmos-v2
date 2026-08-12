// @vitest-environment jsdom
//
// The Updates panel, rendered for real.
//
// WHY THIS EXISTS: the first prod deploy of this page showed the PageShell
// heading and nothing else, and the browser never issued a request to
// /api/v1/admin/updates. The API was verified working from that same page (200,
// correct payload, 488ms), so the failure was in the component. These tests pin
// the three states the panel must have — and the reason the bug was invisible is
// that the original code was `if (!data) return null`, which renders NOTHING
// while loading and NOTHING forever if the query rejects. A panel that is blank
// on error is indistinguishable from one that is blank because it never ran.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UpdatesManager } from "./updates-manager";

const OK = {
  configured: true,
  checkedAt: "2026-08-11T15:31:10.297Z",
  status: { current: "2.276.8", latest: "2.277.1", newer: ["2.277.0", "2.277.1"], updateAvailable: true, ahead: false },
  candidateDigest: `sha256:${"a".repeat(64)}`,
  candidateTag: "2.277.1-alpha",
  preflights: [
    { id: "candidate-resolves", title: "Candidate image exists", status: "pass", detail: "resolves", blocking: true },
    { id: "disk-headroom", title: "Disk headroom", status: "unknown", detail: "not observable here", blocking: true, deferredTo: "host-runner" },
  ],
  notes: [
    {
      version: "2.277.1",
      date: "2026-08-11",
      title: "Something shipped",
      highlights: [{ kind: "feature", text: "A brand new thing." }],
    },
  ],
  notesOmitted: 2,
  applyable: false,
  error: null,
};

let renderPanelResult: ReturnType<typeof render> | null = null;

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (renderPanelResult = render(
    <QueryClientProvider client={qc}>
      <UpdatesManager />
    </QueryClientProvider>,
  ));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

/** Route both endpoints the panel now uses off one stub. */
function stubFetch(check: unknown, deploy: unknown = { latest: null }, onPost?: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/deploy")) {
        if (init?.method === "POST") return onPost ? onPost() : new Response(JSON.stringify({ id: "r1" }), { status: 202 });
        return new Response(JSON.stringify(deploy), { status: 200 });
      }
      return new Response(JSON.stringify(check), { status: 200 });
    }),
  );
}

describe("UpdatesManager — the install control", () => {
  it("offers to install when every blocking check passed", async () => {
    stubFetch({ ...OK, applyable: true });
    renderPanel();
    expect(await screen.findByRole("button", { name: /install 2\.277\.1/i })).toBeTruthy();
  });

  it("REFUSES to offer it while a blocking check has not passed", async () => {
    stubFetch({ ...OK, applyable: false });
    renderPanel();
    const btn = await screen.findByRole("button", { name: /install 2\.277\.1/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/until every blocking check above passes/i)).toBeTruthy();
  });

  it("says a queued request is UNCLAIMED rather than implying progress", async () => {
    // A request nobody picks up means no runner is running. Showing "installing"
    // forever is the exact lie this surface exists to avoid.
    const stale = {
      latest: {
        id: "r1", version: "2.277.1", status: "PENDING",
        requestedAt: new Date().toISOString(), unclaimedMs: 5 * 60_000,
        requestedByEmail: "jon@example.com", claimedAt: null, claimedBy: null,
        finishedAt: null, exitCode: null, log: "",
      },
    };
    stubFetch({ ...OK, applyable: true }, stale);
    renderPanel();
    expect(await screen.findByText(/deploy runner may not be installed/i)).toBeTruthy();
  });

  it("presents ABANDONED as UNKNOWN, never as a failure", async () => {
    const abandoned = {
      latest: {
        id: "r1", version: "2.277.1", status: "ABANDONED",
        requestedAt: new Date().toISOString(), requestedByEmail: "jon@example.com",
        claimedAt: new Date().toISOString(), claimedBy: "host-1",
        finishedAt: new Date().toISOString(), exitCode: null, log: "swept", unclaimedMs: 0,
      },
    };
    stubFetch({ ...OK, applyable: true }, abandoned);
    renderPanel();
    expect(await screen.findByText(/outcome of this install is unknown/i)).toBeTruthy();
  });

  it("surfaces a refusal from the server instead of failing silently", async () => {
    stubFetch({ ...OK, applyable: true }, { latest: null }, () =>
      new Response(JSON.stringify({ error: "A deploy is already in progress on this instance." }), { status: 409 }),
    );
    renderPanel();
    const btn = await screen.findByRole("button", { name: /install/i });
    btn.click();
    expect(await screen.findByText(/already in progress/i)).toBeTruthy();
  });
});

describe("UpdatesManager", () => {
  it("renders the version comparison once the check returns", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(OK), { status: 200 })));
    renderPanel();
    const { container } = renderPanelResult!;
    expect(await screen.findByText("2.277.1-alpha")).toBeTruthy(); // candidate tag surfaced
    // The version now appears in BOTH the comparison row and the notes block,
    // so scope this to the definition list that IS the comparison.
    await waitFor(() => {
      const dds = [...container.querySelectorAll("dd")].map((d) => d.textContent);
      expect(dds).toContain("2.276.8"); // running
      expect(dds).toContain("2.277.1"); // newest available
    });
    // The count sits in its own <span>, so assert on combined text rather than
    // a single text node.
    await waitFor(() => expect(container.textContent).toMatch(/2\s*releases available/i));
  });

  it("shows something while the check is in flight — never a blank panel", async () => {
    // A registry round-trip takes seconds. Rendering null for that whole time
    // is how this shipped looking broken.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // never resolves
    renderPanel();
    expect(await screen.findByText(/checking for updates/i)).toBeTruthy();
  });

  it("shows an ERROR state when the request itself fails, and offers a retry", async () => {
    // The original returned null here, so a failed fetch was indistinguishable
    // from a component that never mounted — which is exactly how long the real
    // diagnosis took.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })));
    renderPanel();
    expect(await screen.findByText(/could not check for updates/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("distinguishes 'registry unreachable' from 'up to date'", async () => {
    const unreachable = { ...OK, status: null, preflights: [], error: "registry listing failed: HTTP 401" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(unreachable), { status: 200 })));
    renderPanel();
    expect(await screen.findByText(/could not reach the registry/i)).toBeTruthy();
    expect(screen.queryByText(/up to date/i)).toBeNull();
  });

  it("says up to date when there is genuinely nothing newer", async () => {
    const current = {
      ...OK,
      status: { current: "2.277.1", latest: "2.277.1", newer: [], updateAvailable: false, ahead: false },
      preflights: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(current), { status: 200 })));
    renderPanel();
    expect(await screen.findByText(/up to date/i)).toBeTruthy();
  });

  it("warns rather than offers when the instance is AHEAD of the registry", async () => {
    const ahead = {
      ...OK,
      status: { current: "2.278.0", latest: "2.277.1", newer: [], updateAvailable: false, ahead: true },
      preflights: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(ahead), { status: 200 })));
    renderPanel();
    expect(await screen.findByText(/newer than anything the registry offers/i)).toBeTruthy();
  });

  it("tells the operator when update checking is not configured at all", async () => {
    const off = { ...OK, configured: false, status: null, preflights: [] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(off), { status: 200 })));
    renderPanel();
    expect(await screen.findByText(/not configured/i)).toBeTruthy();
  });

  it("renders the release notes for the newer versions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(OK), { status: 200 })));
    renderPanel();
    expect(await screen.findByText("A brand new thing.")).toBeTruthy();
    expect(screen.getByText("Something shipped")).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
  });

  it("says how many releases notes were NOT shown for, rather than implying completeness", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(OK), { status: 200 })));
    renderPanel();
    expect(await screen.findByText(/2 older releases are not shown/i)).toBeTruthy();
  });

  it("distinguishes 'no notes published' from 'nothing changed'", async () => {
    const noNotes = { ...OK, notes: [], notesOmitted: 0 };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(noNotes), { status: 200 })));
    renderPanel();
    expect(await screen.findByText(/No release notes are published/i)).toBeTruthy();
  });

  it("labels a DEFERRED check as host-checked, never as 'blocks upgrade'", async () => {
    // Labelling a check that can never be answered on this side as blocking is
    // how a page trains its operator to ignore the badge.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(OK), { status: 200 })));
    renderPanel();
    await waitFor(() => expect(screen.getByText("Disk headroom")).toBeTruthy());
    expect(screen.getAllByText(/checked on the host/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/blocks upgrade/i)).toBeNull();
  });

  it("still says 'blocks upgrade' for a real blocking failure", async () => {
    const blocked = {
      ...OK,
      preflights: [{ id: "sidecars-paired", title: "Plugin sidecar images", status: "fail", detail: "missing", blocking: true }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(blocked), { status: 200 })));
    renderPanel();
    expect(await screen.findByText(/blocks upgrade/i)).toBeTruthy();
  });
});
