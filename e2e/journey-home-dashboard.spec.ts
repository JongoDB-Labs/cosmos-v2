import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — personal Home dashboard widgets. From the org home, add a
 * metric widget and verify it renders. Validates the home_widgets migration +
 * the home-widgets routes + the HomeDashboard UI end to end.
 *
 * Mutating — CI e2e job (Postgres + seed). The CI DB is fresh per run and the
 * seed creates no home widgets, so alice starts at the empty state. "Overdue
 * items" is used because its label doesn't collide with the static StatCards
 * ("Active projects" / "Team members" / "Plan").
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("journey — home dashboard", () => {
  test("add a widget to the personal home dashboard", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    await page.goto(`/${ORG}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });

    // Empty state shows an "Add widget" trigger.
    await page.getByRole("button", { name: /add widget/i }).first().click();
    await page
      .getByRole("menuitem", { name: /^Overdue items$/i })
      .click();

    // The new widget card renders with its label (unique vs the static KPIs).
    await expect(page.getByText("Overdue items").first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
