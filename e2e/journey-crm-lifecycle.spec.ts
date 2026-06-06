import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — CRM pipeline lifecycle. On the CRM pipeline board, create a
 * contact in the LEAD stage via the column's inline "Add contact" affordance,
 * confirm the card renders, then delete it through the card's action menu +
 * confirmation dialog. Guards the just-shipped fix that drops a deleted card
 * from the board's local state immediately (no reload): PipelineBoard wires
 * ContactCard.onDelete -> handleContactDelete which filters the contact out of
 * the local useState array.
 *
 * Deliberately does NOT test stage-move via drag-and-drop — that path is the
 * known-flaky non-gating `e2e-interaction` failure. Create + delete are
 * deterministic (raw fetch -> local state update on success).
 *
 * Mutating — runs in the CI e2e job (Postgres + test-fixtures seed). Needs only
 * the seeded org; alice is ADMIN so she has CRM_CREATE and CRM_DELETE (the
 * Delete action only renders with CRM_DELETE). Unique stamped name per run so
 * retries on the shared CI DB can't collide.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("journey — CRM lifecycle", () => {
  test("create a contact then delete it off the board", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const stamp = Date.now().toString().slice(-6);
    const name = `E2E Contact ${stamp}`;

    await page.goto(`/${ORG}/crm`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });

    // The LEAD column's inline add affordance. The board renders one "Add
    // contact" ghost button per stage; LEAD is the first column, so .first()
    // opens the LEAD add-input.
    await page
      .getByRole("button", { name: /add contact/i })
      .first()
      .click();

    // Inline create: only the name is user-supplied (stage is implied by the
    // column — handleAddContact sends { name, stage }). Submit with the "Add"
    // button. On POST success the new contact is appended to local state.
    const nameInput = page.getByPlaceholder("Contact name...");
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    await nameInput.fill(name);
    await page.getByRole("button", { name: /^Add$/ }).click();

    // The new card renders. The card root is role=button with
    // aria-label="Open contact <name>". Use exact:true: the dnd-kit sortable
    // WRAPPER is also role=button and its accessible name CONTAINS the card's
    // ("Open contact <name> Open menu"), so a substring match is ambiguous
    // (strict-mode violation). Exact matches only the card's own aria-label.
    const card = page.getByRole("button", {
      name: `Open contact ${name}`,
      exact: true,
    });
    await expect(card).toBeVisible({ timeout: 20_000 });

    // Open the card's action menu. The "Open menu" trigger sits next to the
    // card inside the same hover group and is opacity-0 until hover, so hover
    // the card first to reveal it. Scope the trigger lookup to the card's
    // wrapper so we hit this card's menu, not another column's.
    await card.hover();
    const cardWrapper = card.locator("xpath=..");
    await cardWrapper.getByRole("button", { name: /open menu/i }).click();

    // Click the Delete menu item (role=menuitem). Scoped to the open menu so it
    // doesn't collide with the card's aria-label or the dialog's button.
    await page
      .getByRole("menuitem", { name: /delete/i })
      .click();

    // Confirm in the "Delete contact?" dialog via its destructive Delete button.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole("button", { name: /^Delete$/ }).click();

    // The fix under test: onDelete drops the contact from local state, so the
    // card disappears immediately without a reload.
    await expect(card).toHaveCount(0, { timeout: 15_000 });
  });
});
