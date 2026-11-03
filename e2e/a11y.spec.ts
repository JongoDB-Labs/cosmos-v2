import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures/auth";
import { runAxe, blocking } from "./fixtures/axe";
import { openIssues, resetQueryLanguage, setQueryLanguage } from "./fixtures/issues-query";

/**
 * Accessibility regression harness (ported from cosmos-prod). Signs in and runs
 * a WCAG 2 A/AA scan on each key authenticated surface, failing on any
 * serious/critical violation. Keeps the a11y wins from rotting as the UI
 * changes.
 *
 * The route list is reconciled to v2's actual IA (see nav-config.ts /
 * topbar-nav.ts): the grouped sidebar (Overview / Projects / Issues /
 * Time-Tracking / CRM group / Accounting group / Analytics / Settings) plus the
 * topbar tabs (Chat / Meetings / Notes / Team). The Accounting group's pages
 * live under /accounting/* so each URL segment matches its nav label.
 * Project-scoped feature tabs
 * (goals / kpis / milestones) are excluded because they sit behind per-project
 * feature toggles the CI seed doesn't enable — visiting them would render an
 * error/empty surface and pass falsely; their components are covered by the
 * static audit instead.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
// The seeded "TEST" project (test-fixtures.ts); matched case-insensitively.
const KEY = process.env.E2E_PROJECT_KEY ?? "test";

// Routes that render for the seeded CI org (org + ADMIN + the "TEST" project &
// its default KANBAN board). The kanban board is reached via a STATIC path:
// /projects/{key} server-redirects to /projects/{key}/boards/{id}, so no
// dynamic board id is hardcoded. Raw /boards/[id] and /chat/[id] stay excluded.
/**
 * `redirects: true` marks a path that does not render itself — it sends the
 * browser somewhere else. Those need an extra wait before anything inspects the
 * page; see the note at the goto below.
 */
const PAGES: Array<{ name: string; path: string; redirects?: true }> = [
  { name: "overview", path: "" },
  // Top-level sidebar nav.
  { name: "projects", path: "/projects" },
  { name: "project board (kanban)", path: `/projects/${KEY}` },
  { name: "board templates", path: `/projects/${KEY}/boards/new` },
  { name: "issues", path: "/issues" },
  { name: "time-tracking", path: "/time-tracking" },
  // CRM group.
  { name: "crm", path: "/crm" },
  { name: "crm/partners", path: "/partners" },
  { name: "crm/products", path: "/products" },
  { name: "crm/contracts", path: "/contracts" },
  // Accounting group. Every path mirrors its breadcrumb trail; the old
  // /finance/* paths still 307 here (src/lib/nav/legacy-redirects.ts).
  { name: "accounting (redirects to first child)", path: "/accounting", redirects: true },
  { name: "accounting/finance", path: "/accounting/finance" },
  { name: "accounting/invoices", path: "/accounting/invoices" },
  { name: "accounting/banking", path: "/accounting/banking" },
  { name: "accounting/payroll", path: "/accounting/payroll" },
  { name: "accounting/tax", path: "/accounting/tax" },
  // Analytics.
  { name: "analytics", path: "/analytics" },
  { name: "analytics/reports", path: "/analytics/reports" },
  // Topbar tabs.
  { name: "chat", path: "/chat" },
  { name: "meetings", path: "/meetings" },
  { name: "notes", path: "/notes" },
  { name: "team", path: "/team" },
  // The full-page assistant was retired for the drawer (scanned below); the old
  // path redirects to the org home.
  { name: "assistant (redirects to overview)", path: "/assistant", redirects: true },
  { name: "pm-dashboard", path: "/pm-dashboard" },
  // Settings.
  // /settings is now a redirect to the viewer's first accessible page (profile
  // for the e2e admin). Kept as a surface to guard that the redirect lands on
  // an accessible page.
  { name: "settings (redirects to first accessible)", path: "/settings", redirects: true },
  { name: "settings/profile", path: "/settings/profile" },
  { name: "settings/preferences", path: "/settings/preferences" },
  { name: "settings/security", path: "/settings/security" },
  // Org-wide pages (ADMIN); rendered fully when signed in as the e2e admin.
  { name: "settings/organization", path: "/settings/organization" },
  { name: "settings/account-security", path: "/settings/account-security" },
  { name: "settings/roles", path: "/settings/roles" },
  { name: "settings/webhooks", path: "/settings/webhooks" },
  { name: "settings/integrations", path: "/settings/integrations" },
  { name: "settings/mcp-servers", path: "/settings/mcp-servers" },
  { name: "settings/custom-fields", path: "/settings/custom-fields" },
  { name: "settings/classifications", path: "/settings/classifications" },
  { name: "settings/compliance", path: "/settings/compliance" },
  { name: "settings/audit-logs", path: "/settings/audit-logs" },
  { name: "settings/templates", path: "/settings/templates" },
  // Themes now redirects to /settings/organization (v2.101.0). Kept as a
  // surface to guard that the redirect lands on an accessible page.
  { name: "settings/themes (redirects to organization)", path: "/settings/themes", redirects: true },
];

test.describe("a11y — WCAG 2 A/AA across key surfaces", () => {
  for (const { name, path, redirects } of PAGES) {
    test(`${name} has no serious/critical axe violations`, async ({
      page,
      signInAs,
    }) => {
      await signInAs(EMAIL);

      // Scan the SETTLED UI: emulate "reduce motion" so entrance animations don't
      // run under the scan. framer's app-wide `reducedMotion="user"` only drops
      // transform/layout animations — it deliberately keeps opacity/color fades —
      // so fade-in wrappers (e.g. StaggeredGrid) explicitly honor reduce and
      // render at final opacity. Without this, axe catches muted text mid-fade at
      // partial opacity (a transient ~3.5:1 that isn't a real, settled violation)
      // and the job flakes/retries across many surfaces until it times out.
      await page.emulateMedia({ reducedMotion: "reduce" });

      await page.goto(`/${ORG}${path}`, { waitUntil: "domcontentloaded" });

      // A redirect route's goto() returns BEFORE the redirect runs. Measured on
      // all three, with `waitUntil: "domcontentloaded"`:
      //
      //   /settings/themes  goto returned at .../settings/themes,
      //                     scanned at .../settings/organization
      //   /settings         goto returned at .../settings,
      //                     scanned at .../settings/profile
      //   /accounting       goto returned at .../accounting,
      //                     scanned at .../accounting/finance
      //
      // So the scan could begin mid-navigation, and the guard below cannot see
      // it: `/${ORG}/settings/themes` starts with `/${ORG}` exactly as the
      // destination does, so a half-finished navigation reads as a successful
      // landing. This spec describes itself as scanning the SETTLED UI, and
      // that has to include the redirect settling.
      //
      // The assertion is "we are no longer on the path we asked for", NOT "the
      // URL stopped changing for a moment" — the first version of this waited
      // for two equal readings 150ms apart and passed instantly, every time,
      // because the redirect had not fired yet. It looked like a fix and was a
      // no-op. It is also NOT a hardcoded destination: where these land is
      // RBAC-dependent, and pinning it here would turn a permissions change
      // into a confusing a11y failure.
      if (redirects) {
        await expect
          .poll(() => new URL(page.url()).pathname, {
            timeout: 15_000,
            intervals: [100],
            message: `${name}: still on the pre-redirect path — the redirect never ran`,
          })
          .not.toBe(`/${ORG}${path}`);
      }

      // Fail loudly if we didn't land on the authenticated org page. Without
      // this, a sign-in / org-membership regression redirects every page to
      // /login (a clean screen with no violations) and all tests pass falsely
      // — silently disabling the entire a11y gate.
      const landedPath = new URL(page.url()).pathname;
      expect(
        landedPath.startsWith(`/${ORG}`),
        `expected to land on /${ORG}${path}, got ${landedPath} — sign-in or redirect regression?`,
      ).toBe(true);

      await page.waitForSelector("main", { timeout: 20_000 });

      // Wait for the route's loading skeletons to clear — the real
      // "content rendered" signal. networkidle is useless here: a persistent
      // notifications EventSource keeps a connection open forever, so it would
      // just burn its timeout and leave the scan resting on a blind sleep.
      //
      // This asserts on ALL skeletons and FAILS if they never clear. It used to
      // be `.first().waitFor({ state: "detached" }).catch(() => {})`, which had
      // two holes: `.first()` waited for ONE skeleton to detach rather than all
      // of them, and the empty catch swallowed the timeout — so a route that
      // never finished loading was scanned AS A LOADING STATE. A skeleton has
      // no violations, so the scan reported clean and the gate passed on a page
      // it had never actually seen. The Kanban scan was passing exactly that
      // way: it failed 15 of 18 local runs once it waited properly, and all
      // three "passes" had 17 skeletons still on screen.
      await expect(
        page.locator('[data-slot="skeleton"]'),
        `${name} still had loading skeletons on screen — axe would have scanned the loading state, which always passes`,
      ).toHaveCount(0, { timeout: 20_000 });
      await page.waitForTimeout(500);

      // Don't scan a route error boundary — its trivially-accessible UI has no
      // violations and would pass falsely. Every dashboard error boundary
      // renders a "Retry" button.
      await expect(
        page.getByRole("button", { name: /^retry$/i }),
        `${name} rendered an error boundary instead of content`,
      ).toHaveCount(0);

      const violations = await runAxe(page);
      const serious = blocking(violations);
      expect(
        serious,
        `serious/critical a11y violations on ${name}:\n` +
          serious
            .map((v) => `  [${v.impact}] ${v.id} — ${v.help} @ ${v.targets[0]}`)
            .join("\n"),
      ).toHaveLength(0);
    });
  }
});

/**
 * Every OTHER board type.
 *
 * The scan above reaches exactly one board view: `/projects/{KEY}` redirects to
 * the TEST project's default KANBAN board. Nothing in the suite ever opened a
 * Calendar, Scrum, Backlog, Table, Timeline, Roadmap, OKR, Dashboard, RAID, CFD
 * or ceremony board — so `button-name`, a rule this gate has always run, never
 * saw their markup, and the Calendar's month arrows shipped (2.509.1) with no
 * accessible name at all.
 *
 * The seed has no board of those types: `prisma/seed/test-fixtures.ts` gives the
 * TEST project two boards and both are KANBAN. So it now also seeds a "Board
 * Gallery" project (key GALLERY) carrying one board of every `BoardType` on a
 * FIXED SLUG, plus one active sprint and four work items — enough that the views
 * render their real chrome rather than an empty state. Its own project, because
 * TEST is the target of a dozen mutating journeys that count its items and read
 * its board tab strip; sixteen more tabs there would move the DOM under all of
 * them. These scans never mutate it.
 *
 * `ready` is NOT decoration, and it is a LIST because one anchor is not enough.
 * A wrong slug, a `notFound()`, or a project-key change leaves the URL intact
 * and renders something else, and axe is perfectly happy on a 404 — so every
 * entry names something only ITS view renders. But a board's chrome arrives
 * before its body, and a scan taken in between reports the loading state: the
 * Scrum board's first run failed `scrollable-region-focusable` on
 * `KanbanBoardMountSkeleton` (sprint-board.tsx), because the sprint <h2> comes
 * from the intervals query while the Kanban is still mounting. That was the
 * spec reporting its own impatience, not a product defect. So where the body
 * loads separately from the chrome, `ready` names one of each.
 *
 * PORTFOLIO and PROGRAM are deliberately absent: `BOARD_VIEWS` in
 * `boards/[boardId]/board-renderer.tsx` maps both to the same `DashboardView`
 * that `dashboard` below already scans, so they would cost runtime and add no
 * markup. Give either its own view and it needs a row here.
 *
 * KNOWN GAP, so nobody reads a green run as more than it is: the gallery's
 * boards all have cards, and a Kanban column strip with cards has focusable
 * children. An EMPTY one does not — `kanban-board.tsx`'s `overflow-x-auto p-4`
 * strip then fails `scrollable-region-focusable` (serious), measured 15 times
 * out of 18 on the TEST project's empty board, with and without this gallery
 * seeded. That is pre-existing and is NOT covered here; the `project board
 * (kanban)` scan above only passes it because its 500ms settle sometimes lands
 * on the loading skeleton (17 skeletons still on screen in every clean run).
 * Fixing it is a keyboard-focus change plus tightening that wait, together.
 */
const GALLERY_KEY = process.env.E2E_GALLERY_PROJECT_KEY ?? "GALLERY";

const BOARDS: Array<{
  name: string;
  slug: string;
  /** Things ONLY this board's view renders — chrome AND body. All asserted
   *  visible before axe runs. */
  ready: (page: Page) => Locator[];
  /**
   * Rule ids this scan FOUND and that are deliberately NOT fixed here, because
   * the fix is outside the "give a control a name" boundary this change was
   * scoped to (a colour token, in both cases below). The assertion is an EXACT
   * set match, not an allowance: a new rule fails the test, and so does fixing
   * one of these — which is the point, since it forces the entry to be deleted
   * rather than left to rot into a blanket exemption.
   */
  known?: string[];
}> = [
  // The gallery's Kanban is not a repeat of the scan above: it has cards and a
  // Cancelled column, and the TEST board has neither — so this is the first
  // time a work-item card is scanned at all.
  { name: "kanban", slug: "kanban", ready: (p) => [p.getByText("Gallery item in progress")] },
  // Two anchors: the sprint name (an <h2>, so it cannot match the tab strip)
  // proves this is the SCRUM view, and the card proves its Kanban has mounted.
  {
    name: "scrum",
    slug: "scrum",
    ready: (p) => [
      p.getByRole("heading", { name: "Sprint 1" }),
      p.getByText("Gallery item in progress"),
    ],
  },
  // Both ceremony kinds share one tablist ("Ceremony section"); the tab NAMES
  // are what tell planning from review (ceremony-board.tsx).
  {
    name: "sprint planning (ceremony)",
    slug: "sprint-planning",
    ready: (p) => [p.getByRole("tab", { name: "Capacity" })],
  },
  {
    name: "sprint review (ceremony)",
    slug: "sprint-review",
    ready: (p) => [p.getByRole("tab", { name: "What shipped" })],
  },
  { name: "backlog", slug: "backlog", ready: (p) => [p.getByText("Gallery item in backlog")] },
  // "Group by:" is Table's own toolbar label (a raw <select>, unlike every
  // other board's grouping control), and it renders only after the data query
  // resolves — table-view early-returns a skeleton while loading.
  {
    name: "table",
    slug: "table",
    ready: (p) => [p.getByText("Group by:"), p.getByText("Gallery item in review")],
  },
  // The two month arrows are the controls 2.509.1 gave names to. The card
  // anchor is why the seed pins due dates to a day of the CURRENT month: on a
  // `now + N days` date they fall off the visible grid late in a month.
  {
    name: "calendar",
    slug: "calendar",
    ready: (p) => [
      p.getByRole("button", { name: "Next month" }),
      p.getByRole("button", { name: "Gallery item in progress" }),
    ],
    // The per-day "N item" toggle is `text-muted-foreground` at 10px on the
    // `bg-muted` day cell: 4.32:1 against a 4.5:1 requirement
    // (calendar-view.tsx:311, and the "+N more" twin at :347). Fixing it is a
    // colour decision, not a naming one.
    known: ["color-contrast"],
  },
  {
    name: "timeline (gantt)",
    slug: "timeline",
    ready: (p) => [
      p.getByRole("button", { name: "Zoom in" }),
      p.getByText("Gallery item in progress"),
    ],
  },
  // The static snapshot variant of TIMELINE (config.mode). Anchored on the
  // read-only badge, not on "Release Timeline" — that string is also the board's
  // own tab label, and getByText is a case-insensitive substring match.
  {
    name: "release timeline",
    slug: "release-timeline",
    ready: (p) => [p.getByText("read-only snapshot")],
  },
  // Roadmap's toolbar outlives its rows (the empty-state fix) — the gallery has
  // no Epic-type items, so this scans that branch's chrome on purpose.
  {
    name: "roadmap",
    slug: "roadmap",
    ready: (p) => [p.getByRole("button", { name: /^(Collapse all|Expand all)$/ })],
  },
  // OKR's view switcher. It is a real tablist as of 2.511.0 — it used to be
  // three plain <button>s whose labels were lowercase literals capitalised by
  // CSS, so this anchor was `role="button"` named "alignment". Both halves of
  // that changed in the same release this spec landed beside.
  { name: "okrs", slug: "okrs", ready: (p) => [p.getByRole("tab", { name: "Alignment" })] },
  {
    name: "dashboard",
    slug: "dashboard",
    ready: (p) => [p.getByRole("tablist", { name: "Sprint health view" })],
  },
  // A RAID column heading, not the "RAID log" toolbar text: the board's tab is
  // named "RAID Log", which a substring match would also hit.
  {
    name: "raid",
    slug: "raid",
    ready: (p) => [
      p.getByRole("heading", { name: "Assumptions" }),
      p.getByText("Gallery item in backlog"),
    ],
    // The status/label chips on a RAID card are `--text-muted` on a 12% tint of
    // itself: 3.91:1 (raid-view.tsx:694 and :706). Inside a card, and a colour
    // decision — same reason as the Calendar above.
    known: ["color-contrast"],
  },
  {
    name: "cumulative flow",
    slug: "cfd",
    // Not `getByRole("heading")`: 2.511.0 moved this board's title into the
    // shared `BoardToolbarTitle`, which renders a styled <div>, so there is no
    // heading role here any more.
    ready: (p) => [p.getByText("Cumulative Flow Diagram")],
  },
];

test.describe("a11y — every board type", () => {
  for (const { name, slug, ready, known } of BOARDS) {
    test(`${name} board has no serious/critical axe violations`, async ({ page, signInAs }) => {
      // Each board view is its own client chunk under `next dev`, so the first
      // visit pays a compile the shared 30s default does not cover.
      test.setTimeout(90_000);
      await signInAs(EMAIL);
      await page.emulateMedia({ reducedMotion: "reduce" });

      const path = `/${ORG}/projects/${GALLERY_KEY}/boards/${slug}`;
      await page.goto(path, { waitUntil: "domcontentloaded" });

      // A seeded slug IS the canonical URL, so the board page never redirects
      // us — anything else means the slug or the project key moved.
      expect(
        new URL(page.url()).pathname,
        `${name}: expected to stay on ${path} — did the seeded slug or project key change?`,
      ).toBe(path);

      await page.waitForSelector("main", { timeout: 20_000 });

      // EVERY skeleton gone, not just the first one to appear. These boards load
      // in stages — the Scrum board swaps one skeleton for another — and
      // `.first().waitFor({ state: "detached" })` is satisfied by the first
      // stage finishing, which is how the scan came to be taken over a loading
      // state in the first place.
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 30_000 });

      // The positive control: prove we are looking at THIS board's view, and at
      // its content rather than its loading state, before believing a clean scan.
      for (const anchor of ready(page)) {
        await expect(
          anchor.first(),
          `${name}: the board view never rendered — a 404 or a loading state scans clean and proves nothing`,
        ).toBeVisible({ timeout: 30_000 });
      }

      await expect(
        page.getByRole("button", { name: /^retry$/i }),
        `${name} board rendered an error boundary instead of content`,
      ).toHaveCount(0);
      await page.waitForTimeout(500);

      const serious = blocking(await runAxe(page));
      const found = [...new Set(serious.map((v) => v.id))].sort();
      expect(
        found,
        `serious/critical a11y violations on the ${name} board do not match the known set.\n` +
          `  expected: ${JSON.stringify([...(known ?? [])].sort())}\n` +
          `  found:\n` +
          serious
            .map((v) => `    [${v.impact}] ${v.id} — ${v.help} @ ${v.targets[0]}`)
            .join("\n") +
          `\n  A rule listed as known that no longer fires has been FIXED — delete it from` +
          ` BOARDS rather than leaving a standing exemption.`,
      ).toEqual([...(known ?? [])].sort());
    });
  }
});

// The query language bar (query design §14.3): both modes, with chips and the
// CodeMirror editor on screen. The beta is off by default, so it is switched
// on for these two scans and back off after.
test.describe("a11y — Issues query language", () => {
  test.afterAll(async ({ browser }) => {
    await resetQueryLanguage(browser);
  });

  for (const mode of ["basic", "advanced"] as const) {
    test(`issues (query language, ${mode}) has no serious/critical axe violations`, async ({ page, signInAs }) => {
      await signInAs(EMAIL);
      await setQueryLanguage(page.request, true);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openIssues(page, { cql: "assignee = me AND priority IN (HIGH, CRITICAL)", mode });
      if (mode === "advanced") await expect(page.getByRole("textbox", { name: "Query" })).toBeVisible({ timeout: 20_000 });
      else await expect(page.getByRole("group", { name: "Filter: Priority" })).toBeVisible();
      await page.waitForTimeout(500);
      const serious = blocking(await runAxe(page));
      expect(
        serious,
        serious.map((v) => `  [${v.impact}] ${v.id} — ${v.help} @ ${v.targets[0]}`).join("\n"),
      ).toHaveLength(0);
    });
  }

  test("project Filters tab (query language) has no serious/critical axe violations", async ({ page, signInAs }) => {
    await signInAs(EMAIL);
    await setQueryLanguage(page.request, true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/${ORG}/projects/${KEY}/filters`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("link", { name: "Filters" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/No filters shared with this project|Project filters/).first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500);
    const serious = blocking(await runAxe(page));
    expect(serious, serious.map((v) => `  [${v.impact}] ${v.id} — ${v.help} @ ${v.targets[0]}`).join("\n")).toHaveLength(0);
  });
});

test.describe("a11y — the assistant drawer", () => {
  test("assistant drawer has no serious/critical axe violations", async ({
    page,
    signInAs,
  }) => {
    await signInAs(EMAIL);
    await page.emulateMedia({ reducedMotion: "reduce" });
    // A full load, not "domcontentloaded": the drawer opens from a client
    // handler, so clicking before hydration does nothing.
    await page.goto(`/${ORG}`);
    await page.waitForSelector("main", { timeout: 20_000 });
    await page.getByRole("button", { name: "Open assistant" }).click();
    await expect(page.getByPlaceholder(/type a message/i).first()).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(500);

    const serious = blocking(await runAxe(page));
    expect(
      serious,
      "serious/critical a11y violations with the assistant drawer open:\n" +
        serious
          .map((v) => `  [${v.impact}] ${v.id} — ${v.help} @ ${v.targets[0]}`)
          .join("\n"),
    ).toHaveLength(0);
  });
});
