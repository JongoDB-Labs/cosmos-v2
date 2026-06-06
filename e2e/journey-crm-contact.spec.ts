import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — create a CRM contact. From the CRM pipeline board, use the
 * first stage column's (Lead) inline "Add contact" affordance, submit a name,
 * and verify the contact card appears in that column. Exercises auth + the
 * org-level CRM create mutation + the optimistic board update.
 *
 * Self-contained (no project/board needed — contacts are org-level). Mutating →
 * runs in the gated CI e2e job; the non-mutating selector path was validated
 * locally. Unique name per run avoids cross-run confusion on the shared DB.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("journey — CRM contact", () => {
  test("add a contact: it appears as a card in the Lead stage", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const name = `E2E Contact ${Date.now().toString().slice(-6)}`;

    await page.goto(`/${ORG}/crm`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });
    // Wait for the pipeline board to finish its client fetch (skeleton clears).
    await page
      .locator('[data-slot="skeleton"]')
      .first()
      .waitFor({ state: "detached", timeout: 10_000 })
      .catch(() => {});
    await expect(page.getByText("Lead", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // The first stage (Lead) is STAGES[0], so the first "Add contact" button is
    // its column's. Reveal the inline form, fill the name, submit.
    await page
      .getByRole("button", { name: /add contact/i })
      .first()
      .click();
    const nameInput = page.getByPlaceholder("Contact name...");
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    await nameInput.fill(name);
    await page.getByRole("button", { name: "Add", exact: true }).click();

    // The new contact is appended to the board and renders as a card whose root
    // is role=button aria-label "Open contact {name}" (optimistic, no redirect).
    // .first() — the card root and its dnd-sortable wrapper both expose the
    // "Open contact {name}" accessible name.
    await expect(
      page.getByRole("button", { name: `Open contact ${name}` }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
