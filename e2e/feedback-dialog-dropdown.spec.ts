import { test, expect } from "./fixtures/auth";

/**
 * E2E — COSMOS-173. The Submit-feedback dialog's Type / Project pickers used to
 * take the whole dialog down, discarding a half-written draft.
 *
 * NOT by the route the report guessed. Picking an option was never able to
 * dismiss a modal dialog — base-ui only treats a press as an outside press when
 * the target is the dialog's own backdrop or an ancestor of its popup, and a
 * portalled option is neither. The press that killed it was one that MISSED the
 * option list: the picker's own full-viewport backdrop should have absorbed it,
 * but that backdrop carries no z-index and was painted beneath DialogOverlay
 * (z-50), so the overlay took the press and dismissed the dialog.
 *
 * THIS IS THE FALSIFIABLE TEST FOR THE FIX. It has to live in Playwright: which
 * element a press reaches is a question about painting, and jsdom neither
 * paints nor hit-tests — a jsdom click goes to whichever element you name, so
 * it can never catch this. Every press below is issued by COORDINATE so the
 * browser picks the target exactly as a user's mouse would. Revert the portal's
 * stacking classes in src/components/ui/select.tsx and the first test fails on
 * a dismissed dialog and a lost draft.
 *
 * The dialog dismisses on an outside press like any other, which is what makes
 * the failure reachable — it is not held open by a prop.
 *
 * Mutating only in the submit step, which files one uniquely-titled item. Needs
 * the seeded "TEST" project from prisma/seed/test-fixtures.ts so the Project
 * picker has something to choose.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

/**
 * Press a point the way a mouse does — travel, then a held click. Base UI reads
 * an instant press-release right after a picker opens as the tail of the press
 * that opened it, so the movement and the hold both matter.
 */
async function pressAt(page: import("@playwright/test").Page, x: number, y: number) {
  await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.click(x, y, { delay: 80 });
}

async function pressCentre(
  page: import("@playwright/test").Page,
  locator: ReturnType<import("@playwright/test").Page["locator"]>,
) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("nothing to press");
  await pressAt(page, box.x + box.width / 2, box.y + box.height / 2);
}

/** Open the submit dialog with a draft typed into it. */
async function openDraft(page: import("@playwright/test").Page, title: string) {
  await page.goto(`/${ORG}/feedback`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("main", { timeout: 20_000 });
  await page.getByRole("button", { name: /submit feedback/i }).first().click();
  const dialog = page.locator("[data-slot='dialog-content']");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await page.locator("#fb-title").fill(title);
  return dialog;
}

// Scoped to the picker's portal: the board's own filter and sort controls are
// native <select>s, whose <option>s answer to role=option too.
const PICKER_OPTIONS = "[data-slot='select-portal'] [role='option']";

test.describe("feedback submit dialog — dropdowns (COSMOS-173)", () => {
  test("a press that misses an open picker closes the picker, not the dialog", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);
    const title = `E2E Dropdown ${Date.now().toString().slice(-6)}`;

    const dialog = await openDraft(page, title);
    const options = page.locator(PICKER_OPTIONS);

    await pressCentre(page, page.locator("#fb-type"));
    await expect(options.first()).toBeVisible({ timeout: 10_000 });
    // Let the opening press finish. Base UI ignores a release that arrives in
    // the moment after a picker opens, treating it as the tail of the press
    // that opened it — press inside that window and it is swallowed before it
    // can reach any backdrop, which would let this test pass by luck on
    // unfixed code. Waiting puts the press squarely in the regime the bug
    // lives in.
    await page.waitForTimeout(400);

    // Top-left, far from the option list. Before the fix this reached
    // DialogOverlay and the dialog — and the draft — went with it.
    await pressAt(page, 20, 20);

    // The list closes either way — that is the press doing its job. Base UI
    // leaves the closed popup in the DOM in its exit state, so ask about
    // visibility rather than presence.
    await expect(options.first()).toBeHidden();

    // Then let a dismissal, if one was triggered, finish. A dialog on its way
    // out is still in the DOM with its fields intact for the length of its exit
    // animation, so asserting straight after the press reads as "survived" on
    // a dialog that is already dying — which is exactly how this test passed on
    // unfixed code until the wait was added.
    await page.waitForTimeout(600);
    await expect(dialog).toHaveCount(1);
    await expect(page.locator("#fb-title")).toHaveValue(title);
  });

  test("every dropdown is selectable without closing the dialog, and Submit files both", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);
    const title = `E2E Dropdown ${Date.now().toString().slice(-6)}`;

    const dialog = await openDraft(page, title);

    await pressCentre(page, page.locator("#fb-type"));
    await pressCentre(page, page.getByRole("option", { name: /bug report/i }));
    await expect(dialog).toBeVisible();
    await expect(page.locator("#fb-type")).toContainText("Bug report");

    await pressCentre(page, page.locator("#fb-project"));
    await pressCentre(page, page.getByRole("option", { name: /Test Project/i }));
    await expect(dialog).toBeVisible();
    await expect(page.locator("#fb-project")).toContainText("Test Project");
    await expect(page.locator("#fb-title")).toHaveValue(title);

    await page.getByRole("button", { name: /^Submit$/ }).click();
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 20_000 });
  });

  test("a real backdrop press still closes the dialog", async ({ page, signInAs }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const dialog = await openDraft(page, "E2E backdrop");
    // No picker open, so this press is the dialog's own — it must dismiss.
    await pressAt(page, 20, 20);

    await expect(dialog).toHaveCount(0);
  });

  test("Escape still closes the dialog", async ({ page, signInAs }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const dialog = await openDraft(page, "E2E escape");
    await page.keyboard.press("Escape");

    await expect(dialog).toHaveCount(0);
  });
});
