import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — time-tracking log + submit. From the time-tracking page, open
 * the "Log Time" dialog, create a DRAFT entry (hours + a unique description on
 * today's date), submit the WEEK, then switch to the List view and assert that
 * entry's status flipped DRAFT → SUBMITTED.
 *
 * Submission is PERIOD-level as of the approval workflow: the per-row "Submit
 * for approval" button is gone, replaced by "Submit week" in the week header.
 * Submitting entries one at a time produced half-submitted weeks that no
 * approver or payroll run could interpret.
 *
 * Mutating — CI e2e job (Postgres + seed). alice is ADMIN → has TIME_CREATE
 * (log own) + TIME_APPROVE. The List view shows the raw status enum text
 * (DRAFT / SUBMITTED) per row. Approval needs a DIFFERENT person — alice
 * cannot approve her own timesheet once she has a supervisor — so the journey
 * ends at SUBMITTED.
 *
 * TIMING: the TimeTracker uses a raw fetch + a `refreshKey` bump (NOT React
 * Query) and only refetches when the view / filters / refreshKey change. Save
 * is async and the dialog closes only after the POST resolves, so we WAIT FOR
 * THE DIALOG TO CLOSE before switching to the List view — that guarantees the
 * entry is committed before the list fetch runs, otherwise the list can load
 * once (pre-commit) and never see the new row.
 *
 * The CI DB is shared across retries, so the description carries a unique
 * per-run suffix and every assertion is scoped to that entry's row — other
 * pre-existing entries in the List view can't make the selectors ambiguous.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("journey — time tracking", () => {
  test("log a time entry then submit it for approval", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const stamp = Date.now().toString().slice(-6);
    const description = `E2E Time ${stamp}`;

    await page.goto(`/${ORG}/time-tracking`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });

    // Open the "Log Time" dialog and fill the create form. Hours is the only
    // required field (project is optional; date defaults to today).
    await page.getByRole("button", { name: /log time/i }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: /^Log Time$/i }),
    ).toBeVisible({ timeout: 10_000 });

    await dialog.locator("#te-hours").fill("2.5");
    await dialog.locator("#te-desc").fill(description);
    await dialog.getByRole("button", { name: /^Save$/ }).click();

    // The dialog closes ONLY after the POST resolves (and bumps refreshKey), so
    // waiting for it to disappear guarantees the entry is persisted before we
    // trigger the list fetch below.
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Submit the WEEK from the week-view header. The entry was logged for
    // today, so it is in the week currently on screen.
    const submitWeek = page.getByRole("button", { name: /submit week/i }).first();
    await expect(submitWeek).toBeEnabled({ timeout: 15_000 });
    await submitWeek.click();

    // The period's badge is the immediate confirmation the action landed.
    await expect(page.getByText("Submitted").first()).toBeVisible({
      timeout: 15_000,
    });

    // Switch to the List view and confirm the ENTRY moved with its timesheet —
    // the propagation that keeps CLIN burn and payroll (which filter on
    // TimeEntry.status) working without joining through the timesheet.
    await page.getByRole("button", { name: /^List$/ }).first().click();

    const entryRow = page
      .getByRole("row")
      .filter({ hasText: description })
      .first();
    await expect(entryRow).toBeVisible({ timeout: 20_000 });
    await expect(entryRow.getByText("SUBMITTED").first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
