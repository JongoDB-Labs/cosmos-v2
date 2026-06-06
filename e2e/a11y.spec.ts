import { test, expect } from "./fixtures/auth";
import { runAxe, blocking } from "./fixtures/axe";

/**
 * Accessibility regression harness (codifies the manual axe audits of rounds
 * 16/17). Signs in and runs a WCAG 2 A/AA scan on each key authenticated
 * surface, failing on any serious/critical violation. Keeps the a11y wins from
 * rotting as the UI changes.
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
  { name: "projects", path: "/projects" },
  { name: "project board (kanban)", path: `/projects/${KEY}` },
  { name: "board templates", path: `/projects/${KEY}/boards/new` },
  { name: "crm", path: "/crm" },
  { name: "finance", path: "/finance" },
  { name: "analytics", path: "/analytics" },
  { name: "analytics/reports", path: "/analytics/reports" },
  { name: "notes", path: "/notes" },
  { name: "meetings", path: "/meetings" },
  { name: "time-tracking", path: "/time-tracking" },
  { name: "assistant", path: "/assistant" },
  { name: "chat", path: "/chat" },
  { name: "team", path: "/team" },
  { name: "settings", path: "/settings" },
  { name: "settings/profile", path: "/settings/profile" },
  { name: "settings/preferences", path: "/settings/preferences" },
  { name: "settings/security", path: "/settings/security" },
  { name: "settings/webhooks", path: "/settings/webhooks" },
  { name: "settings/integrations", path: "/settings/integrations" },
  { name: "settings/mcp-servers", path: "/settings/mcp-servers" },
  { name: "settings/custom-fields", path: "/settings/custom-fields" },
  { name: "settings/classifications", path: "/settings/classifications" },
  { name: "settings/compliance", path: "/settings/compliance" },
  { name: "settings/audit-logs", path: "/settings/audit-logs" },
  { name: "settings/templates", path: "/settings/templates" },
  { name: "settings/themes", path: "/settings/themes" },
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
      // /login (a clean screen with no violations) and all 11 tests pass
      // falsely — silently disabling the entire a11y gate.
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
