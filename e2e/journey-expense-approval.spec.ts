import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — expense approval workflow. Create an expense (DRAFT), submit it
 * for approval (SUBMITTED), then approve it (APPROVED), asserting the status
 * badge at each step. Validates the additive migration (status column),
 * the submit + approve routes, and the finance-dashboard UI end to end.
 *
 * Mutating — CI e2e job (Postgres + seed). alice is ADMIN → has FINANCE_MANAGE
 * (create/submit own) + EXPENSE_APPROVE (approve). The CI DB is fresh per run
 * and the seed creates no expenses, so this test's expense is the only row —
 * status text + the single "Open menu" trigger are unambiguous.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("journey — expense approval", () => {
  test("create → submit → approve an expense", async ({ page, signInAs }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const stamp = Date.now().toString().slice(-6);
    const category = `E2E Exp ${stamp}`;

    await page.goto(`/${ORG}/finance`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });

    // Switch to the Expenses tab and open the create dialog.
    await page.getByRole("button", { name: /^Expenses$/i }).first().click();
    await page.getByRole("button", { name: /add expense/i }).first().click();
    await expect(page.getByRole("heading", { name: /add expense/i })).toBeVisible({
      timeout: 10_000,
    });

    // Amount + a unique category (date defaults to today; Save needs both).
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^Amount$/i).fill("42.50");
    await dialog.getByLabel(/^Category$/i).fill(category);
    await dialog.getByRole("button", { name: /^Save$/ }).click();

    // Created as DRAFT.
    await expect(page.getByText(category).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Draft").first()).toBeVisible({ timeout: 10_000 });

    // Submit for approval → SUBMITTED.
    await page.getByRole("button", { name: "Open menu" }).first().click();
    await page.getByRole("menuitem", { name: /submit for approval/i }).click();
    await expect(page.getByText("Submitted").first()).toBeVisible({ timeout: 15_000 });

    // Approve → APPROVED.
    await page.getByRole("button", { name: "Open menu" }).first().click();
    await page.getByRole("menuitem", { name: /^Approve$/i }).click();
    await expect(page.getByText("Approved").first()).toBeVisible({ timeout: 15_000 });
  });
});
