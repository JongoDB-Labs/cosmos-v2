import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — feedback portal. Open the portal, submit a feature request, and
 * verify it appears in the list. Validates the new feedback migration + the
 * create/list routes + the portal UI end to end.
 *
 * Mutating — runs in the CI e2e job (Postgres + test-fixtures seed). Any member
 * (alice has ORG_READ) can submit. Unique title per run for the shared CI DB.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("journey — feedback portal", () => {
  test("submit a feature request and see it listed", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const stamp = Date.now().toString().slice(-6);
    const title = `E2E Feedback ${stamp}`;

    await page.goto(`/${ORG}/feedback`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });

    await page.getByRole("button", { name: /submit feedback/i }).click();
    await expect(
      page.getByRole("heading", { name: /submit feedback/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Type defaults to "Feature request".
    await page.getByLabel(/^Title$/).fill(title);
    await page.getByRole("button", { name: /^Submit$/ }).click();

    await expect(page.getByText(title).first()).toBeVisible({ timeout: 20_000 });
  });
});
