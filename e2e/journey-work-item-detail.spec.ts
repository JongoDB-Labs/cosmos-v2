import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — open a work item's detail. Creates a card on the seeded board's
 * first column, clicks it, and asserts the detail Sheet (role=dialog) opens.
 * Exercises auth + the create mutation + the click-to-open detail (read-only).
 *
 * Needs the seeded "TEST" project + default KANBAN board (+ built-in
 * WorkItemType for the create step). Opening the detail is read-only. Mutating
 * only via the prerequisite card create. Unique title per run.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const PROJECT_KEY = process.env.E2E_PROJECT_KEY ?? "test";

test.describe("journey — work item detail", () => {
  test("create a card then open its detail sheet", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const title = `E2E Detail ${Date.now().toString().slice(-6)}`;

    await page.goto(`/${ORG}/projects/${PROJECT_KEY}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .waitForURL(/\/boards\/[0-9a-f-]{36}$/i, { timeout: 20_000 })
      .catch(() => {});
    await page.waitForSelector("main", { timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: "Backlog" }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // Create a card to have something to open.
    await page.getByRole("button", { name: "Add card" }).first().click();
    const titleInput = page.getByPlaceholder("Card title...");
    await expect(titleInput).toBeVisible({ timeout: 10_000 });
    await titleInput.fill(title);
    await titleInput.press("Enter");

    // The card renders; its accessible name is "Open {KEY}-{n}: {title}".
    const card = page.getByRole("button", { name: title }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Click it → the detail Sheet (a portal'd base-ui dialog) opens.
    await card.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
  });
});
