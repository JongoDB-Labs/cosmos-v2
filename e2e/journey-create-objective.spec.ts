import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — OKRs. The OkrBoard client shipped already but 404'd because the
 * Objective/KeyResult model + /objectives routes never existed. This validates
 * the fix end-to-end: the migration created the tables, the routes match the
 * client's contract, and creating an objective works (no more 404).
 *
 * Mutating — runs in the CI e2e job (Postgres + test-fixtures seed). Needs the
 * seeded "TEST" project; alice is ADMIN so she has OKR_CREATE. Unique title per
 * run so retries on the shared CI DB don't collide.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const KEY = process.env.E2E_PROJECT_KEY ?? "test";

test.describe("journey — OKRs", () => {
  test("create an objective and see it on the board", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const stamp = Date.now().toString().slice(-6);
    const title = `E2E Objective ${stamp}`;

    await page.goto(`/${ORG}/projects/${KEY}/okrs`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("main", { timeout: 20_000 });

    // "Add Objective" appears in both the empty state and below an existing list.
    await page
      .getByRole("button", { name: /add objective/i })
      .first()
      .click();

    const input = page.getByPlaceholder("Objective title...");
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(title);
    await page.getByRole("button", { name: /^Add$/ }).click();

    // The objective renders on the board (previously the GET/POST 404'd).
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 20_000 });
  });
});
