import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — switch between boards. The seeded "TEST" project has two boards
 * (default KANBAN "Board" + seeded "Roadmap"). From the first board, click the
 * other board's tab and assert the URL navigates to that board. Read-only
 * (pure client navigation). Board-name-agnostic: finds the tab pointing at a
 * different board id, so it also works locally against any 2-board project.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const PROJECT_KEY = process.env.E2E_PROJECT_KEY ?? "test";

test.describe("journey — board switching", () => {
  test("clicking another board tab navigates to that board", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    await page.goto(`/${ORG}/projects/${PROJECT_KEY}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL(/\/boards\/[0-9a-f-]{36}$/i, { timeout: 20_000 });
    await page.waitForSelector("main", { timeout: 20_000 });

    const currentId = new URL(page.url()).pathname.split("/boards/")[1];

    // Board tabs are <Link href=".../boards/{uuid}">; the "New Board" link ends
    // in /boards/new. Collect the board-id tabs.
    const tabs = page.locator('a[href*="/boards/"]');
    await expect(tabs.first()).toBeVisible({ timeout: 15_000 });
    const hrefs = (
      await tabs.evaluateAll((els) =>
        els.map((e) => (e as HTMLAnchorElement).getAttribute("href") || ""),
      )
    ).filter((h) => /\/boards\/[0-9a-f-]{36}$/i.test(h));

    // Find a tab pointing at a DIFFERENT board than the one we're on.
    const otherHref = hrefs.find((h) => !h.endsWith(currentId));
    expect(
      otherHref,
      "expected a second board tab to switch to (seed Board + Roadmap)",
    ).toBeTruthy();

    // Wait for the URL to land on the OTHER board specifically — a generic
    // /boards/{uuid}$ match would pass immediately on the current board (no nav
    // wait) and race the SPA navigation.
    const otherId = otherHref!.split("/boards/")[1];
    expect(otherId).not.toBe(currentId);
    await page.locator(`a[href="${otherHref}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/boards/${otherId}$`), {
      timeout: 15_000,
    });
  });
});
