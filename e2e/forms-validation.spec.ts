import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/auth";
import { runAxe } from "./fixtures/axe";

/**
 * Forms validation a11y contract — locks in the R23 FormField work
 * (src/components/ui/form-field.tsx). Drives the profile form's required
 * "Display name" field through a FAILED submit and asserts the accessible error
 * wiring: `aria-required` is announced up front, then on an empty submit the
 * control gets `aria-invalid="true"` and an inline error <p> that is associated
 * back to the field via `aria-describedby`.
 *
 * Only the INVALID path is exercised (client validation returns before the
 * mutation fires — profile-form.tsx save()), so nothing is ever persisted.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("forms — FormField validation contract", () => {
  test("profile: required field exposes an accessible inline error on invalid submit", async ({
    page,
    signInAs,
  }) => {
    await signInAs(EMAIL);
    await page.goto(`/${ORG}/settings/profile`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("main", { timeout: 20_000 });
    // Let the page-transition settle — during its enter animation the outgoing
    // and incoming pages briefly coexist, double-rendering the form.
    await page
      .locator('[data-slot="skeleton"]')
      .first()
      .waitFor({ state: "detached", timeout: 10_000 })
      .catch(() => {});

    // The required "Display name" field. Match by label prefix — the visible
    // label carries a trailing required "*" marker (aria-hidden, but part of the
    // label's text), so an exact "Display name" match wouldn't resolve it.
    const name = page.getByLabel(/^Display name/i);
    // Wait for the transition's transient duplicate to clear (single instance).
    await expect(name).toHaveCount(1, { timeout: 15_000 });
    await expect(name).toBeVisible();

    // Required is announced up front; the error wiring is absent until it fails.
    await expect(name).toHaveAttribute("aria-required", "true");
    await expect(name).not.toHaveAttribute("aria-invalid", "true");

    // Clear the required field and submit -> client validation rejects it.
    await name.fill("");
    await page.getByRole("button", { name: /save changes/i }).click();

    // aria-invalid flips on.
    await expect(name).toHaveAttribute("aria-invalid", "true");

    // The inline error renders and is associated back to the field. Compare ids
    // rather than constructing a CSS selector (aria-describedby may list several).
    const error = page.getByText("Display name is required");
    await expect(error).toBeVisible();
    const errorId = await error.getAttribute("id");
    expect(errorId, "the inline error <p> should carry an id").toBeTruthy();
    const describedBy = (await name.getAttribute("aria-describedby")) ?? "";
    expect(
      describedBy.split(/\s+/),
      "aria-describedby should reference the inline error's id",
    ).toContain(errorId);

    // Sanity: the optional Email field is NOT marked required.
    const email = page.getByLabel(/^Email/i);
    await expect(email).not.toHaveAttribute("aria-required", "true");
  });

  // WCAG 1.4.3: the error line is 12px text, so it needs 4.5:1. It used
  // `text-destructive`, the fill red, at about 3.8:1 on white.
  for (const colorScheme of ["light", "dark"] as const) {
    test(`profile: the inline error's text passes axe's contrast check (${colorScheme})`, async ({ page, signInAs }) => {
      await signInAs(EMAIL);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme });
      const error = await failSubmit(page);

      const id = (await error.getAttribute("id")) ?? "";
      // useId ids carry punctuation a CSS selector must escape.
      const selector = "#" + id.replace(/[^\w-]/g, (c) => `\\${c}`);
      await runAxe(page, { include: selector, tags: ["color-contrast"] });
      const verdict = await page.evaluate(async (sel) => {
        type Result = { nodes: unknown[] };
        const axe = (window as unknown as {
          axe: { run: (c: unknown, o: unknown) => Promise<Record<"passes" | "violations" | "incomplete", Result[]>> };
        }).axe;
        const res = await axe.run(
          { include: [[sel]] },
          { runOnly: ["color-contrast"], resultTypes: ["passes", "violations", "incomplete"] },
        );
        const count = (k: "passes" | "violations" | "incomplete") => res[k].reduce((n, r) => n + r.nodes.length, 0);
        return { passes: count("passes"), violations: count("violations"), incomplete: count("incomplete") };
      }, selector);
      // A pass, not just no violation: axe measured the line, so "0 violations"
      // is not "axe could not tell" (an unmeasured node lands in incomplete).
      expect(verdict, `axe's color-contrast verdict on the error line (${colorScheme})`).toEqual({
        passes: 1,
        violations: 0,
        incomplete: 0,
      });
    });
  }
});

/** Open the profile form, empty the required name and submit: returns the error line. */
async function failSubmit(page: Page) {
  await page.goto(`/${ORG}/settings/profile`);
  await page.waitForSelector("main", { timeout: 20_000 });
  // One field, not the two the page transition briefly shows.
  const name = page.getByLabel(/^Display name/i);
  await expect(name).toHaveCount(1, { timeout: 15_000 });
  // The form is server-rendered with the saved name, so it can be typed into
  // before React hydrates it. Measured: an empty-and-submit in that window
  // never showed the error, because React still held the saved name. Repeat
  // until the field reports the failure; a submit that slips through only
  // saves the name the field already had.
  await expect(async () => {
    await name.fill("");
    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(name).toHaveAttribute("aria-invalid", "true", { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  const error = page.getByText("Display name is required");
  await expect(error).toBeVisible();
  return error;
}
