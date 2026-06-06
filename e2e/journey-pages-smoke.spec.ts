import { test, expect } from "./fixtures/auth";

/**
 * E2E cross-page render smoke — read-only. Signs in as alice and visits the
 * main org surfaces, asserting each renders <main> plus a recognizable,
 * data-independent heading without crashing.
 *
 * Read-only — visits only already-deployed routes and never mutates anything,
 * so it is safe against the shared CI DB and the existing seed (test-org,
 * alice ADMIN). Routes not yet merged (e.g. /settings/roles) are intentionally
 * excluded.
 *
 * The asserted text is a stable heading rendered by each page's PageShell
 * (<h1>) or PageSection (<h2>) — chosen so it does not depend on seed data:
 *   - overview (/${ORG}) renders org-name as <h1> (varies), so we assert the
 *     static "Active projects" PageSection heading instead.
 *   - the PageShell-based routes render a fixed title as <h1>.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

type SmokeRoute = {
  name: string;
  path: string;
  /** A stable, data-independent heading/text the page always renders. */
  heading: RegExp;
};

const ROUTES: SmokeRoute[] = [
  { name: "overview", path: `/${ORG}`, heading: /^Active projects$/i },
  { name: "analytics", path: `/${ORG}/analytics`, heading: /^Analytics$/ },
  { name: "finance", path: `/${ORG}/finance`, heading: /^Finance$/ },
  { name: "notes", path: `/${ORG}/notes`, heading: /^Notes$/ },
  { name: "crm", path: `/${ORG}/crm`, heading: /^CRM$/ },
  {
    name: "settings/profile",
    path: `/${ORG}/settings/profile`,
    heading: /^Profile$/,
  },
  {
    name: "settings/preferences",
    path: `/${ORG}/settings/preferences`,
    heading: /^Preferences$/,
  },
  {
    name: "settings/security",
    path: `/${ORG}/settings/security`,
    heading: /^Security$/,
  },
];

test.describe("journey — cross-page render smoke", () => {
  for (const route of ROUTES) {
    test(`renders ${route.name} without crashing`, async ({
      page,
      signInAs,
    }) => {
      test.setTimeout(60_000);
      await signInAs(EMAIL);

      await page.goto(route.path, { waitUntil: "domcontentloaded" });

      // The dashboard layout always renders a <main> shell; wait for it before
      // asserting content so we don't race the streamed page body.
      await page.waitForSelector("main", { timeout: 20_000 });

      // A stable heading/text confirms the page actually rendered (not a crash
      // boundary or blank shell).
      await expect(page.getByText(route.heading).first()).toBeVisible({
        timeout: 20_000,
      });
    });
  }
});
