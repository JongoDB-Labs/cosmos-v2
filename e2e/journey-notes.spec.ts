import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — create a note. From /notes, open the editor (header "New Note"
 * or the empty-state "Create Note"), type a required title, Save, and assert the
 * new note card appears in the list. Self-contained (org-level). Mutating →
 * verified in CI; non-mutating selector path validated locally. Unique title.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("journey — notes", () => {
  test("create a note: it appears in the list", async ({ page, signInAs }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const title = `E2E Note ${Date.now().toString().slice(-6)}`;

    await page.goto(`/${ORG}/notes`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });
    await page
      .locator('[data-slot="skeleton"]')
      .first()
      .waitFor({ state: "detached", timeout: 10_000 })
      .catch(() => {});

    // Entry: header "New Note", or the empty-state "Create Note" CTA.
    await page
      .getByRole("button", { name: /new note/i })
      .or(page.getByRole("button", { name: /create note/i }))
      .first()
      .click();

    // Editor opens; title is required (Save disabled until non-empty).
    const titleInput = page.getByPlaceholder("Note title...");
    await expect(titleInput).toBeVisible({ timeout: 10_000 });
    await titleInput.fill(title);
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // The editor closes and the new note card (an <h3> with the title) appears.
    await expect(page.getByRole("heading", { name: title }).first()).toBeVisible(
      { timeout: 15_000 },
    );
  });
});
