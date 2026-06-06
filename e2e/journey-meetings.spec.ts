import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — Meetings. From the org Meetings page, open the "Schedule
 * Meeting" dialog, fill the minimal required field (title; type defaults to
 * Standup and the date defaults to now), create the meeting, and verify it
 * appears in the list.
 *
 * Mutating — runs in the CI e2e job (Postgres + test-fixtures seed). The create
 * flow needs no project/cycle (project is optional, type/date default), so this
 * uses only the seeded org. alice is ADMIN so she has MEETING_CREATE. Unique
 * title per run so retries on the shared CI DB don't clash.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("journey — meetings", () => {
  test("create a meeting and see it in the list", async ({ page, signInAs }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const stamp = Date.now().toString().slice(-6);
    const title = `E2E Meeting ${stamp}`;

    await page.goto(`/${ORG}/meetings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });

    // Open the create dialog ("Schedule Meeting" trigger button).
    await page
      .getByRole("button", { name: /schedule meeting/i })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: /schedule meeting/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Fill the only required field — title. Type defaults to Standup and the
    // date/time defaults to "now", so a minimal path needs nothing else.
    await page.getByLabel(/^Title$/).fill(title);

    await page.getByRole("button", { name: /^create$/i }).click();

    // The new meeting appears in the list (client re-fetch after create).
    await expect(page.getByText(title).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
