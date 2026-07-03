import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — create a board. From the seeded project's board template
 * gallery (/projects/TEST/boards/new), pick the "Kanban Board" template; the
 * card click POSTs and redirects to the new board. Exercises auth + the
 * template gallery + the board create mutation + the redirect.
 *
 * Needs the seeded "TEST" project (prisma/seed/test-fixtures.ts). Mutating →
 * verified in CI; non-mutating selector path validated locally. Re-runs create
 * additional same-named boards, so the assertion is the redirect URL (a unique
 * board UUID), never the tab name.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const PROJECT_KEY = process.env.E2E_PROJECT_KEY ?? "test"; // seeded "TEST"

test.describe("journey — create board", () => {
  test("pick a Kanban template: redirects to the new board", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    await page.goto(`/${ORG}/projects/${PROJECT_KEY}/boards/new`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("main", { timeout: 20_000 });

    // Template cards appear after the built-in templates fetch resolves.
    const kanban = page.getByRole("button", { name: /kanban board/i }).first();
    await expect(kanban).toBeVisible({ timeout: 20_000 });
    await kanban.click();

    // The click is the submit → router.push to the new board's human-readable
    // slug URL — the "Kanban Board" template slugifies to `kanban-board`
    // (with a -N suffix if one already exists), NOT a UUID and NOT /boards/new.
    await expect(page).toHaveURL(/\/projects\/[^/]+\/boards\/kanban-board(-\d+)?$/i, {
      timeout: 25_000,
    });
  });
});
