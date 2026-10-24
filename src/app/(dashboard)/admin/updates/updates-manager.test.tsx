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
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

describe("UpdatesManager — reinstalling a rebuilt image", () => {
  // A composed image carries the CORE version, so a plugin-only release
  // republishes the tag this instance already runs. It is not "up to date", and
  // there is nothing newer to install — reinstalling is the only way to take it.
  const REBUILT = {
    ...OK,
    status: { current: "2.277.1", latest: "2.277.1", newer: [], updateAvailable: false, ahead: false },
    candidateTag: "2.277.1-alpha",
    rebuildAvailable: true,
    notes: [],
    notesOmitted: 0,
    applyable: true,
  };

  it("says the running version was rebuilt, not that the instance is up to date", async () => {
    stubFetch(REBUILT);
    renderPanel();
    expect(await screen.findByText(/has been rebuilt since this instance installed it/i)).toBeTruthy();
    expect(screen.queryByText(/this instance is up to date/i)).toBeNull();
  });

  it("offers Reinstall, and asks for the RUNNING version", async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/deploy")) {
          if (init?.method === "POST") {
            posts.push(String(init.body));
            return new Response(JSON.stringify({ id: "r1" }), { status: 202 });
          }
          return new Response(JSON.stringify({ latest: null }), { status: 200 });
        }
        return new Response(JSON.stringify(REBUILT), { status: 200 });
      }),
    );
    renderPanel();
    const btn = await screen.findByRole("button", { name: /reinstall 2\.277\.1/i });
    fireEvent.click(btn);
    await waitFor(() => expect(posts).toEqual([JSON.stringify({ version: "2.277.1" })]));
  });

  it("keeps Reinstall disabled while a blocking check has not passed", async () => {
    stubFetch({ ...REBUILT, applyable: false });
    renderPanel();
    const btn = await screen.findByRole("button", { name: /reinstall 2\.277\.1/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers nothing when the image was not rebuilt", async () => {
    stubFetch({ ...REBUILT, rebuildAvailable: false, preflights: [], applyable: false });
    renderPanel();
    expect(await screen.findByText(/this instance is up to date/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reinstall/i })).toBeNull();
  });

  it("offers nothing when the instance does not know its own digest — unknown is not 'rebuilt'", async () => {
    stubFetch({ ...REBUILT, rebuildAvailable: null, preflights: [], applyable: false });
    renderPanel();
    expect(await screen.findByText(/this instance is up to date/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reinstall/i })).toBeNull();
  });

  it("offers the upgrade, not a reinstall, when a newer version exists too", async () => {
    stubFetch({ ...OK, rebuildAvailable: true, applyable: true });
    renderPanel();
    expect(await screen.findByRole("button", { name: /install 2\.277\.1/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reinstall/i })).toBeNull();
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

  it("STILL reports the last install after it succeeded and left nothing to upgrade", async () => {
    // The defect this pins, found by installing a release on production: the
    // outcome and log lived inside the install panel, which renders only when
    // `updateAvailable`. Succeeding makes that false — you are now newest — so
    // the panel unmounted at the exact moment it worked and erased its own
    // result. The operator was left inferring success from a version number,
    // with the log unreachable. A FAILED install kept the upgrade on offer and
    // so stayed visible; only success disappeared.
    const upToDate = {
      ...OK,
      status: { current: "2.277.1", latest: "2.277.1", newer: [], updateAvailable: false, ahead: false },
      preflights: [],
    };
    stubFetch(upToDate, {
      latest: {
        id: "r1",
        version: "2.277.1",
        status: "SUCCEEDED",
        requestedAt: "2026-08-11T15:00:00.000Z",
        requestedByEmail: "admin@example.com",
        claimedAt: "2026-08-11T15:00:10.000Z",
        claimedBy: "host-01",
        finishedAt: "2026-08-11T15:02:00.000Z",
        exitCode: 0,
        log: "DEPLOY OK - app serving 2.277.1",
        unclaimedMs: 0,
      },
    });
    renderPanel();

    // Guard the premise: if an upgrade were still on offer this would prove
    // nothing, because the old install panel would have rendered the record.
    expect(await screen.findByText(/up to date/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Install/ })).toBeNull();

    // Assert on things only this card renders — the version string alone also
    // appears as Running / Newest available / Candidate tag.
    expect(await screen.findByText(/Last install/i)).toBeTruthy();
    expect(await screen.findByText(/succeeded/i)).toBeTruthy();
    expect(await screen.findByText(/DEPLOY OK - app serving 2\.277\.1/)).toBeTruthy();
  });

  it("reports an ABANDONED install as UNKNOWN, not as a failure, once nothing is on offer", async () => {
    // Same unmount path, and the case where silence is most dangerous: the
    // outcome genuinely is not known, so the warning has to survive too.
    const upToDate = {
      ...OK,
      status: { current: "2.277.1", latest: "2.277.1", newer: [], updateAvailable: false, ahead: false },
      preflights: [],
    };
    stubFetch(upToDate, {
      latest: {
        id: "r2",
        version: "2.277.1",
        status: "ABANDONED",
        requestedAt: "2026-08-11T15:00:00.000Z",
        requestedByEmail: "admin@example.com",
        claimedAt: "2026-08-11T15:00:10.000Z",
        claimedBy: "host-01",
        finishedAt: "2026-08-11T15:20:00.000Z",
        exitCode: null,
        log: "SWEPT",
        unclaimedMs: 0,
      },
    });
    renderPanel();
    expect(await screen.findByText(/outcome of this install is unknown/i)).toBeTruthy();
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

// Found on prod 2026-08-29, by opening the page rather than reading the code:
// the registry check hung, UpdatesManager early-returned its "Checking for
// updates…" card, and the update-mode switch — mounted BELOW that return — did
// not exist at all. The switch does not depend on the update check, and the
// state in which you most want to reach it (the check is stuck, or failing) was
// exactly the state that hid it.
describe("UpdatesManager — the update-mode switch survives the check's own states", () => {
  /** Update-check never settles; the settings endpoint answers normally. */
  function stubHangingCheck(autoUpdate = true) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/settings")) {
          return new Response(JSON.stringify({ autoUpdate, updatedAt: null }), { status: 200 });
        }
        if (u.includes("/deploy")) return new Response(JSON.stringify({ latest: null }), { status: 200 });
        return new Promise<Response>(() => {}); // never resolves
      }),
    );
  }

  it("is reachable while the update check is still running", async () => {
    stubHangingCheck();
    renderPanel();
    expect(await screen.findByText("Checking for updates…")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Automatic" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manual" })).toBeTruthy();
  });

  it("is reachable when the update check FAILED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/settings")) {
          return new Response(JSON.stringify({ autoUpdate: false, updatedAt: null }), { status: 200 });
        }
        if (u.includes("/deploy")) return new Response(JSON.stringify({ latest: null }), { status: 200 });
        return new Response("boom", { status: 500 });
      }),
    );
    renderPanel();
    expect(await screen.findByText(/Could not check for updates/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Manual" })).toBeTruthy();
  });

  it("shows the stored choice rather than assuming automatic", async () => {
    stubHangingCheck(false);
    renderPanel();
    const manual = await screen.findByRole("button", { name: "Manual" });
    await waitFor(() => expect(manual.getAttribute("aria-pressed")).toBe("true"));
  });
});

// The switch says what SHOULD happen; this pins that the page also says what
// the installer last reported DID happen. Prod sat on 2.427.0 under a switch
// reading "Automatic" with 2.431.1 available, and the only explanation was a log
// file on the host.
describe("UpdatesManager — what the automatic installer last reported", () => {
  const REGISTRY = {
    imageRepo: { value: "registry.example.com/cosmos/assembly/alpha", source: "env", envValue: "registry.example.com/cosmos/assembly/alpha" },
    tagSuffix: { value: "alpha", source: "default", envValue: null },
    username: { value: "deploy", source: "settings", envValue: "env-user" },
    password: { set: true, source: "settings", envSet: true },
  };

  function stubSettings(settings: Record<string, unknown>, onPut?: (body: unknown) => Response) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.includes("/settings")) {
          if (init?.method === "PUT") {
            return onPut ? onPut(JSON.parse(String(init.body))) : new Response(JSON.stringify(settings), { status: 200 });
          }
          return new Response(JSON.stringify({ autoUpdate: true, updatedAt: null, ...settings }), { status: 200 });
        }
        if (u.includes("/deploy")) return new Response(JSON.stringify({ latest: null }), { status: 200 });
        return new Promise<Response>(() => {}); // the version check is irrelevant here
      }),
    );
    return calls;
  }

  it("shows a FAILING installer as an error, with its message, under the switch", async () => {
    stubSettings({
      reconcile: {
        outcome: "failing",
        message: "pull access denied",
        latestReleased: "2.431.1",
        runningVersion: "2.427.0",
        source: "registry.example.com/cosmos/assembly/alpha",
        checkedAt: "2026-10-22T11:59:00.000Z",
        failingSince: "2026-10-22T09:00:00.000Z",
      },
      reconcileHealth: {
        tone: "error",
        headline: "Installing 2.431.1 is failing",
        detail: "pull access denied — failing since Oct 22, 2026, 9:00 AM UTC (3 hours ago).",
      },
      registry: REGISTRY,
    });
    renderPanel();
    const headline = await screen.findByText("Installing 2.431.1 is failing");
    const line = headline.closest("[data-testid='installer-health']") as HTMLElement;
    expect(line.getAttribute("data-tone")).toBe("error");
    expect(headline.className).toMatch(/text-red-600/);
    expect(line.textContent).toMatch(/failing since Oct 22, 2026/);
    expect(line.textContent).toMatch(/Last checked/);
    expect(line.textContent).toMatch(/looking in registry\.example\.com\/cosmos\/assembly\/alpha/);
    // It lives in the "How updates are installed" card, next to the switch.
    expect(screen.getByRole("button", { name: "Automatic" }).closest(".rounded-lg")?.contains(line)).toBe(true);
  });

  it("says the installer has not reported yet — muted, not 'Last checked'", async () => {
    stubSettings({
      reconcile: null,
      reconcileHealth: {
        tone: "muted",
        headline: "The automatic installer hasn't reported in yet",
        detail: "If this instance relies on Foreman to install updates, Foreman may not be running on the host.",
      },
      registry: REGISTRY,
    });
    renderPanel();
    const headline = await screen.findByText("The automatic installer hasn't reported in yet");
    const line = headline.closest("[data-testid='installer-health']") as HTMLElement;
    expect(line.getAttribute("data-tone")).toBe("muted");
    expect(line.textContent).not.toMatch(/Last checked/);
  });

  it("shows a stalled event worker as an error line beside the installer's", async () => {
    stubSettings({
      reconcile: null,
      reconcileHealth: { tone: "ok", headline: "Installed and up to date", detail: null },
      eventBacklog: {
        tone: "error",
        headline: "7 change events are waiting; the oldest for 30 min.",
        detail: "The event worker that runs webhooks and automations looks stopped.",
      },
    });
    renderPanel();
    const headline = await screen.findByText("7 change events are waiting; the oldest for 30 min.");
    const line = headline.closest("[data-testid='event-worker-health']") as HTMLElement;
    expect(line.getAttribute("data-tone")).toBe("error");
    expect(headline.className).toMatch(/text-red-600/);
    expect(line.textContent).toMatch(/looks stopped/);
  });

  it("shows nothing for it when the server doesn't report one", async () => {
    stubSettings({ reconcile: null, reconcileHealth: { tone: "ok", headline: "Installed and up to date", detail: null } });
    renderPanel();
    await screen.findByText("Installed and up to date");
    expect(document.querySelector("[data-testid='event-worker-health']")).toBeNull();
  });

  const JOB = {
    name: "outbox-worker", leader: true, running: false, stuck: false, runningForSeconds: null, lastStartedAt: "2026-10-24T23:29:59.000Z",
    lastSucceededAt: "2026-10-24T23:29:59.500Z", consecutiveFailures: 0, lastErrorClass: null, lastErrorMessage: null, everySeconds: 1,
    lastCounts: null, totals: {} as Record<string, number>,
  };

  it("says the background jobs are off here, and why", async () => {
    stubSettings({
      reconcile: null,
      reconcileHealth: { tone: "ok", headline: "Installed and up to date", detail: null },
      jobs: { enabled: false, reason: "JOBS_DISABLED", jobs: [] },
    });
    renderPanel();
    const line = (await screen.findByText("Background jobs are off on this instance: JOBS_DISABLED.")).closest("[data-testid='jobs-health']") as HTMLElement;
    expect(line.getAttribute("data-tone")).toBe("error");
    expect(screen.queryByRole("table", { name: "Background jobs" })).toBeNull();
  });

  it("lists each job: a stuck one and a failing one say so, the rest are OK", async () => {
    stubSettings({
      reconcile: null,
      reconcileHealth: { tone: "ok", headline: "Installed and up to date", detail: null },
      jobs: {
        enabled: true,
        reason: null,
        jobs: [
          { ...JOB, running: true, stuck: true, runningForSeconds: 3 * 3600 },
          { ...JOB, name: "teams-outbox", leader: false, consecutiveFailures: 2, lastErrorClass: "TypeError", lastErrorMessage: "x is undefined" },
          { ...JOB, name: "domain-events-prune", totals: { events: 532, late: 12 } },
        ],
      },
    });
    renderPanel();
    expect(await screen.findByText("2 background jobs are stuck or failing.")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Background jobs" });
    const row = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
    expect(row("outbox-worker").textContent).toMatch(/leads.*Stuck: running for 3 h/);
    expect(row("teams-outbox").textContent).toMatch(/standby.*Failing \(2×\): TypeError: x is undefined/);
    // What it did since this instance started, the late messages it skipped included.
    expect(row("domain-events-prune").textContent).toMatch(/OKevents 532 · late 12$/);
  });

  it("says the jobs are running, and how many this instance leads", async () => {
    stubSettings({
      reconcile: null,
      reconcileHealth: { tone: "ok", headline: "Installed and up to date", detail: null },
      jobs: { enabled: true, reason: null, jobs: [JOB, { ...JOB, name: "teams-outbox", leader: false }] },
    });
    renderPanel();
    const line = (await screen.findByText("Background jobs are running: this instance leads 1 of 2.")).closest("[data-testid='jobs-health']") as HTMLElement;
    expect(line.getAttribute("data-tone")).toBe("ok");
  });
});

describe("UpdatesManager — registry settings", () => {
  const REGISTRY = {
    imageRepo: { value: "registry.example.com/cosmos/assembly/alpha", source: "env", envValue: "registry.example.com/cosmos/assembly/alpha" },
    tagSuffix: { value: "alpha", source: "default", envValue: null },
    username: { value: "deploy", source: "settings", envValue: "env-user" },
    password: { set: true, source: "settings", envSet: true },
  };

  function stub(onPut?: (body: unknown) => Response) {
    const puts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/settings")) {
          if (init?.method === "PUT") {
            const body = JSON.parse(String(init.body));
            puts.push(body);
            if (onPut) return onPut(body);
          }
          return new Response(JSON.stringify({ autoUpdate: true, updatedAt: null, reconcile: null, registry: REGISTRY }), { status: 200 });
        }
        if (u.includes("/deploy")) return new Response(JSON.stringify({ latest: null }), { status: 200 });
        return new Promise<Response>(() => {});
      }),
    );
    return puts;
  }

  function fieldBlock(label: string) {
    return screen.getByLabelText(label).closest(".space-y-1") as HTMLElement;
  }

  it("shows where each value comes from", async () => {
    stub();
    renderPanel();
    await screen.findByLabelText("Image repository");
    expect(fieldBlock("Image repository").textContent).toMatch(/From environment/);
    expect(fieldBlock("Tag suffix").textContent).toMatch(/Derived from the repository/);
    expect(fieldBlock("Username").textContent).toMatch(/Set here/);
    expect(fieldBlock("Username").textContent).toMatch(/Environment: env-user/);
    expect(fieldBlock("Password").textContent).toMatch(/Saved/);
  });

  it("shows an environment value as a placeholder, not as a saved value", async () => {
    stub();
    renderPanel();
    const repo = (await screen.findByLabelText("Image repository")) as HTMLInputElement;
    expect(repo.value).toBe("");
    expect(repo.placeholder).toBe("registry.example.com/cosmos/assembly/alpha");
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("deploy");
  });

  it("never pre-fills the password", async () => {
    stub();
    renderPanel();
    const pw = (await screen.findByLabelText("Password")) as HTMLInputElement;
    expect(pw.type).toBe("password");
    expect(pw.value).toBe("");
  });

  it("offers 'Use environment value' only for values set here", async () => {
    stub();
    renderPanel();
    await screen.findByLabelText("Image repository");
    expect(within(fieldBlock("Image repository")).queryByRole("button", { name: "Use environment value" })).toBeNull();
    expect(within(fieldBlock("Username")).getByRole("button", { name: "Use environment value" })).toBeTruthy();
  });

  it("'Use environment value' on the password sends clearPassword", async () => {
    const puts = stub();
    renderPanel();
    await screen.findByLabelText("Password");
    fireEvent.click(within(fieldBlock("Password")).getByRole("button", { name: "Use environment value" }));
    await waitFor(() => expect(puts).toEqual([{ registry: { clearPassword: true } }]));
  });

  it("Save sends only the fields that were edited", async () => {
    const puts = stub();
    renderPanel();
    const repo = await screen.findByLabelText("Image repository");
    fireEvent.change(repo, { target: { value: "registry.new.example.com/cosmos/app" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(puts).toEqual([{ registry: { imageRepo: "registry.new.example.com/cosmos/app" } }]),
    );
  });

  it("shows the server's refusal when the registry probe fails", async () => {
    stub(() =>
      new Response(JSON.stringify({ error: "Could not list versions in registry.new.example.com/cosmos/app with these settings (registry listing failed: HTTP 401). Nothing was saved." }), { status: 400 }),
    );
    renderPanel();
    fireEvent.change(await screen.findByLabelText("Image repository"), {
      target: { value: "registry.new.example.com/cosmos/app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Nothing was saved/)).toBeTruthy();
  });

  it("says a UI change does not change where the host pulls images from", async () => {
    stub();
    renderPanel();
    expect(await screen.findByText(/docker-compose\.override\.yml/)).toBeTruthy();
  });
});
