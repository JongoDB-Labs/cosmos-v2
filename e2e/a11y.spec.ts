import { test, expect } from "./fixtures/auth";
import { runAxe, blocking } from "./fixtures/axe";

/**
 * Accessibility regression harness (ported from cosmos-prod). Signs in and runs
 * a WCAG 2 A/AA scan on each key authenticated surface, failing on any
 * serious/critical violation. Keeps the a11y wins from rotting as the UI
 * changes.
 *
 * The route list is reconciled to v2's actual IA (see nav-config.ts /
 * topbar-nav.ts): the grouped sidebar (Overview / Projects / Issues /
 * Time-Tracking / CRM group / Accounting group / Analytics / Settings) plus the
 * topbar tabs (Chat / Meetings / Notes / Team). Project-scoped feature tabs
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
const PAGES: Array<{ name: string; path: string }> = [
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
  // Accounting group.
  { name: "finance", path: "/finance" },
  { name: "finance/accounting", path: "/finance/accounting" },
  { name: "finance/invoices", path: "/finance/invoices" },
  { name: "finance/banking", path: "/finance/banking" },
  { name: "finance/payroll", path: "/finance/payroll" },
  { name: "finance/tax", path: "/finance/tax" },
  // Analytics.
  { name: "analytics", path: "/analytics" },
  { name: "analytics/reports", path: "/analytics/reports" },
  // Topbar tabs.
  { name: "chat", path: "/chat" },
  { name: "meetings", path: "/meetings" },
  { name: "notes", path: "/notes" },
  { name: "team", path: "/team" },
  { name: "assistant", path: "/assistant" },
  // Settings.
  // /settings is now a redirect to the viewer's first accessible page (profile
  // for the e2e admin). Kept as a surface to guard that the redirect lands on
  // an accessible page.
  { name: "settings (redirects to first accessible)", path: "/settings" },
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
  { name: "settings/themes (redirects to organization)", path: "/settings/themes" },
];

test.describe("a11y — WCAG 2 A/AA across key surfaces", () => {
  for (const { name, path } of PAGES) {
    test(`${name} has no serious/critical axe violations`, async ({
      page,
      signInAs,
    }) => {
      await signInAs(EMAIL);
      await page.goto(`/${ORG}${path}`, { waitUntil: "domcontentloaded" });

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
      await page
        .locator('[data-slot="skeleton"]')
        .first()
        .waitFor({ state: "detached", timeout: 15_000 })
        .catch(() => {});
      await page.waitForTimeout(500);

      // Don't scan a route error boundary — its trivially-accessible UI has no
      // violations and would pass falsely. Every dashboard error boundary
      // renders a "Retry" button.
      await expect(
        page.getByRole("button", { name: /^retry$/i }),
        `${name} rendered an error boundary instead of content`,
      ).toHaveCount(0);

      // Freeze animations/transitions so the scan sees FINAL states. Card fade-ins
      // (opacity 0->1) and other entrance transitions otherwise get caught mid-flight,
      // where partial opacity transiently drops text contrast below AA — a scan-timing
      // artifact, not a real regression (the settled UI meets contrast).
      await page.addStyleTag({ content: "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}" });
      await page.waitForTimeout(100);
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
