import { expect, type Page } from "@playwright/test";

/**
 * Create a work item from a board using the shared "New issue" dialog.
 *
 * Replaces the per-column "Add card" quick-create, which every board lost when
 * they were unified onto the same full dialog the Issues page uses. The column a
 * card lands in is now chosen explicitly through the dialog's Status picker
 * rather than implied by which column's button you pressed — which is what makes
 * it possible to still seed a specific column here.
 *
 * `statusName` must be a column's DISPLAY name ("Backlog", "To Do"), matching
 * the seeded board in prisma/seed/test-fixtures.ts. Omit it to accept the
 * board's first status.
 */
export async function createIssueFromBoard(
  page: Page,
  title: string,
  statusName?: string,
) {
  await page.getByRole("button", { name: "New issue" }).first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  // Wait for the dialog to SETTLE before touching it. It loads statuses,
  // members and intervals independently, and each arrival grows the form — which
  // moves a centered dialog, so Playwright's "stable" check on the submit button
  // can fail for as long as things are still landing. Statuses are the last of
  // the three to matter here, so a populated Status picker is the signal that
  // the layout has stopped moving.
  const status = dialog.getByLabel("Status");
  await expect
    .poll(async () => (await status.locator("option").allTextContents()).length, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  await expect(status).toBeEnabled({ timeout: 10_000 });

  if (statusName) {
    await expect(
      status.locator("option", { hasText: statusName }),
    ).toHaveCount(1, { timeout: 10_000 });
    await status.selectOption({ label: statusName });
  }

  // Typed AFTER the loads have landed. The dialog resets its form when it opens,
  // and anything still arriving used to be able to re-trigger that reset and
  // wipe a half-typed title.
  await dialog.getByLabel("Title").fill(title);

  const submit = dialog.getByRole("button", { name: "Create issue" });
  await expect(submit).toBeEnabled({ timeout: 10_000 });
  await submit.click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // The board refetches after create (rather than appending client-side, as the
  // quick-create did), so allow for the round trip.
  const card = page.getByRole("button", { name: title }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  return card;
}
