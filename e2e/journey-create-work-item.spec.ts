import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — create a work item (kanban card). On the seeded project's
 * default board, use the first column's inline "Add card" quick-create, type a
 * title, submit with Enter, and verify the card appears. Exercises auth + the
 * kanban board + the work-item create mutation + the optimistic board update.
 *
 * Needs the seeded "TEST" project (its default KANBAN board has columns) AND
 * the seeded built-in WorkItemType "software.task" — both in
 * prisma/seed/test-fixtures.ts. Mutating → verified in CI; non-mutating selector
 * path validated locally. Unique title per run.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const PROJECT_KEY = process.env.E2E_PROJECT_KEY ?? "test"; // seeded "TEST"

test.describe("journey — create work item", () => {
  test("add a card to a column: it appears on the board", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const title = `E2E Card ${Date.now().toString().slice(-6)}`;

    // /projects/<key> redirects to the project's first (default) board.
    await page.goto(`/${ORG}/projects/${PROJECT_KEY}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .waitForURL(/\/projects\/[^/]+\/boards\/[0-9a-f-]{36}$/i, { timeout: 20_000 })
      .catch(() => {});
    await page.waitForSelector("main", { timeout: 20_000 });

    // Wait for the board to render its columns (first column heading "Backlog").
    await expect(
      page.getByRole("heading", { name: "Backlog" }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // The first column's quick-create. Reveal the inline form, type, submit.
    await page
      .getByRole("button", { name: "Add card" })
      .first()
      .click();
    const titleInput = page.getByPlaceholder("Card title...");
    await expect(titleInput).toBeVisible({ timeout: 10_000 });
    await titleInput.fill(title);
    await titleInput.press("Enter");

    // The created card is appended client-side and renders its title.
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 15_000 });
  });
});
