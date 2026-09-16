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
 * This lives in Playwright because that is the only place it can. Which element
 * a press reaches is a question about painting, and jsdom neither paints nor
 * hit-tests — a jsdom click goes to whichever element you name, so it can never
 * catch this. Every press below is issued by COORDINATE so the browser decides
 * the target exactly as a user's mouse would.
 *
 * Non-mutating apart from the final submit, which files one uniquely-titled
 * item. Needs the seeded "TEST" project from prisma/seed/test-fixtures.ts for
 * the Project picker to have something to choose.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("feedback submit dialog — dropdowns (COSMOS-173)", () => {
  test("a press aimed at a picker never reaches the dialog", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const title = `E2E Dropdown ${Date.now().toString().slice(-6)}`;

    await page.goto(`/${ORG}/feedback`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });

    await page.getByRole("button", { name: /submit feedback/i }).first().click();
    const dialog = page.locator("[data-slot='dialog-content']");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await page.locator("#fb-title").fill(title);

    /**
     * Press a point the way a mouse does — travel, then a held click. Base UI
     * reads an instant press-release right after a picker opens as the tail of
     * the press that opened it, so the movement and the hold both matter.
     */
    const pressAt = async (x: number, y: number) => {
      await page.mouse.move(x, y, { steps: 6 });
      await page.mouse.click(x, y, { delay: 80 });
    };
    const pressCentre = async (locator: ReturnType<typeof page.locator>) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error("nothing to press");
      await pressAt(box.x + box.width / 2, box.y + box.height / 2);
    };
    /** What the browser says is on top at a point — the crux of this bug. */
    const topmostAt = (x: number, y: number) =>
      page.evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py);
        return el?.closest("[data-slot]")?.getAttribute("data-slot") ?? null;
      }, [x, y]);

    // Scoped to the picker's portal: the board's own filter and sort controls
    // are native <select>s, whose <option>s answer to role=option too.
    const pickerOptions = page.locator("[data-slot='select-portal'] [role='option']");

    // 1. THE FIX. With a picker open, the layer covering the rest of the screen
    //    must be the PICKER's backdrop. Before the fix this was the dialog's
    //    overlay, and a press here dismissed the dialog and lost the draft.
    await pressCentre(page.locator("#fb-type"));
    await expect(pickerOptions.first()).toBeVisible({ timeout: 10_000 });
    expect(await topmostAt(20, 20)).toBe("select-portal");

    // …so pressing there closes the list and leaves everything else alone.
    await pressAt(20, 20);
    await expect(page.locator("#fb-title")).toHaveValue(title);
    await expect(dialog).toHaveCount(1);
    // Base UI leaves the closed popup in the DOM in its exit state, so ask
    // about visibility rather than presence.
    await expect(pickerOptions.first()).toBeHidden();

    // 2. Picking an option in EVERY dropdown keeps the dialog and applies.
    await pressCentre(page.locator("#fb-type"));
    await pressCentre(page.getByRole("option", { name: /bug report/i }));
    await expect(dialog).toBeVisible();
    await expect(page.locator("#fb-type")).toContainText("Bug report");

    await pressCentre(page.locator("#fb-project"));
    await pressCentre(page.getByRole("option", { name: /Test Project/i }));
    await expect(dialog).toBeVisible();
    await expect(page.locator("#fb-project")).toContainText("Test Project");
    await expect(page.locator("#fb-title")).toHaveValue(title);

    // 3. Submit still files it, with both selections, in one pass.
    await page.getByRole("button", { name: /^Submit$/ }).click();
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 20_000 });
  });
});
