import { test, expect } from "./fixtures/auth";

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
});
