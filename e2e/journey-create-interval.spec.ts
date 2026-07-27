import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — Interval workspace. From the project's Intervals page, open the
 * create dialog, plan an interval, and verify it appears in the list. Exercises
 * the interval CRUD wire-up against the production-grade /intervals API.
 *
 * Renamed from the old "cycle" vocabulary alongside the domain rename in #426
 * (v2.233.0), which moved the route to /intervals and the copy to
 * "New interval" / "Plan an interval" / "Create interval". The spec was missed
 * at the time, so it drove a deleted route, got Next's built-in 404 (which
 * renders no <main>), and hung the e2e shard on waitForSelector("main").
 *
 * Mutating — runs in the CI e2e job (Postgres + test-fixtures seed). Needs the
 * seeded "TEST" project; alice is ADMIN (org) + MANAGER (project) so she has
 * SPRINT_CREATE. Unique name per run so retries on the shared CI DB don't clash.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const KEY = process.env.E2E_PROJECT_KEY ?? "test";

test.describe("journey — interval workspace", () => {
  test("plan an interval and see it in the list", async ({ page, signInAs }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const stamp = Date.now().toString().slice(-6);
    const name = `E2E Interval ${stamp}`;

    await page.goto(`/${ORG}/projects/${KEY}/intervals`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("main", { timeout: 20_000 });

    // Open the create dialog.
    await page.getByRole("button", { name: /new interval/i }).first().click();
    await expect(
      page.getByRole("heading", { name: /plan an interval/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Fill the form (kind defaults from the project's sector; Sprint for software).
    await page.getByLabel(/^Name$/).fill(name);
    await page.getByLabel(/start date/i).fill("2026-07-01");
    await page.getByLabel(/end date/i).fill("2026-07-14");

    await page.getByRole("button", { name: /create interval/i }).click();

    // The new interval appears in the list (client re-fetch after create).
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
  });
});
