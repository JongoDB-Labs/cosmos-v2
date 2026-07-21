import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — global command palette (⌘K / Ctrl+K). Open it, search a project
 * by name, and select the result to navigate to it. Read-only. Guards the
 * search fix (the API now returns the flat {id,type,name,url} shape the palette
 * consumes; previously it returned a grouped object → zero results).
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
// The seeded project is named "Test Project" (key TEST); "Test" matches it.
const QUERY = process.env.E2E_SEARCH_QUERY ?? "Test";

test.describe("journey — command palette", () => {
  test("search a project and navigate to it from the palette", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    // Must be on an org-scoped route so the palette resolves the current org.
    await page.goto(`/${ORG}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });

    // Open via the topbar "Search" button (the explicit control, visible at the
    // Desktop Chrome viewport) — avoids racing the ⌘K keydown listener's mount.
    await page
      .getByRole("button", { name: /search/i })
      .first()
      .click();
    const input = page.getByPlaceholder(/Search everything/i);
    await expect(input).toBeVisible({ timeout: 10_000 });

    await input.fill(QUERY);
    const result = page.getByRole("option").filter({ hasText: /Test Project/i }).first();
    await expect(result).toBeVisible({ timeout: 10_000 });
    await result.click();

    // Selecting a result router.pushes to its url (a project → its board).
    await expect(page).toHaveURL(/\/projects\//, { timeout: 10_000 });
  });
});
