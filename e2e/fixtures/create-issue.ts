import { expect, type Page } from "@playwright/test";

/**
 * Create a work item from a board using the shared "New issue" dialog.
 *
 * Replaces the per-column "Add card" quick-create, which every board lost when
 * they were unified onto the same full dialog the Issues page uses. The column
 * a card lands in is now chosen explicitly through the dialog's Status picker
 * rather than implied by which column's button you pressed — which is what
 * makes it possible to still seed a specific column here.
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

  await dialog.getByLabel("Title").fill(title);

  if (statusName) {
    // The Status options are loaded from the board asynchronously, so wait for
    // the one we want rather than selecting into a list that is still empty.
    const status = dialog.getByLabel("Status");
    await expect(status.locator(`option`, { hasText: statusName })).toHaveCount(1, {
      timeout: 15_000,
    });
    await status.selectOption({ label: statusName });
  }

  await dialog.getByRole("button", { name: "Create issue" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // The board refetches after create (rather than appending client-side, as the
  // quick-create did), so allow for the round trip.
  const card = page.getByRole("button", { name: title }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  return card;
}
