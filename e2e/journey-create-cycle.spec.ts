import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — Sprint/Cycle workspace. From the project's Cycles page (which
 * replaced the old "coming soon" EmptyState), open the create dialog, plan a
 * cycle, and verify it appears in the list. Exercises the cycle CRUD wire-up
 * against the production-grade /cycles API.
 *
 * Mutating — runs in the CI e2e job (Postgres + test-fixtures seed). Needs the
 * seeded "TEST" project; alice is ADMIN (org) + MANAGER (project) so she has
 * SPRINT_CREATE. Unique name per run so retries on the shared CI DB don't clash.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const KEY = process.env.E2E_PROJECT_KEY ?? "test";

test.describe("journey — cycle workspace", () => {
  test("plan a cycle and see it in the list", async ({ page, signInAs }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const stamp = Date.now().toString().slice(-6);
    const name = `E2E Cycle ${stamp}`;

    await page.goto(`/${ORG}/projects/${KEY}/cycles`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("main", { timeout: 20_000 });

    // Open the create dialog.
    await page.getByRole("button", { name: /new cycle/i }).first().click();
    await expect(
      page.getByRole("heading", { name: /plan a cycle/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Fill the form (kind defaults to Sprint).
    await page.getByLabel(/^Name$/).fill(name);
    await page.getByLabel(/start date/i).fill("2026-07-01");
    await page.getByLabel(/end date/i).fill("2026-07-14");

    await page.getByRole("button", { name: /create cycle/i }).click();

    // The new cycle appears in the list (client re-fetch after create).
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
  });
});
