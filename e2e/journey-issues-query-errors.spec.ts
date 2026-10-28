import { test, expect } from "./fixtures/auth";
import { editor, openIssues, resetQueryLanguage, setQueryLanguage } from "./fixtures/issues-query";

/**
 * Mistakes in a query are shown where they are, with a fix when there is an
 * obvious one, and Filters says why it can't show a query instead of rewriting it.
 */
test.describe("Issues — query errors", () => {
  test.afterAll(async ({ browser }) => {
    await resetQueryLanguage(browser);
  });

  test("a misspelt field is underlined, explained and one click from right", async ({ page, signInAs }) => {
    test.setTimeout(60_000);
    await signInAs("alice@test.local");
    await setQueryLanguage(page.request, true);
    await openIssues(page, { mode: "advanced" });

    const ed = editor(page);
    await ed.click();
    await ed.pressSequentially("priorty = HIGH", { delay: 10 });
    await page.keyboard.press("Escape");
    const mark = page.locator(".cm-lintRange-error").first();
    await expect(mark).toBeVisible({ timeout: 10_000 });
    await mark.hover();
    const tip = page.locator(".cm-tooltip-lint");
    await expect(tip).toContainText("Did you mean `priority`");
    await tip.getByRole("button", { name: "Use priority" }).click();
    await expect(ed).toHaveText("priority = HIGH");
    await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);
  });

  test("an operator the field doesn't take is an error", async ({ page, signInAs }) => {
    await signInAs("alice@test.local");
    await setQueryLanguage(page.request, true);
    await openIssues(page, { mode: "advanced" });
    const ed = editor(page);
    await ed.click();
    await ed.pressSequentially("status ~ x", { delay: 10 });
    await page.keyboard.press("Escape");
    const mark = page.locator(".cm-lintRange-error").first();
    await expect(mark).toBeVisible({ timeout: 10_000 });
    await mark.hover();
    await expect(page.locator(".cm-tooltip-lint")).toContainText("status");
  });

  test("Filters is disabled, with the reason, for OR across groups", async ({ page, signInAs }) => {
    await signInAs("alice@test.local");
    await setQueryLanguage(page.request, true);
    await openIssues(page, { cql: "priority = HIGH OR (assignee = me AND due < now())", mode: "basic" });
    const basic = page.getByRole("button", { name: "Filters", exact: true });
    await expect(basic).toBeDisabled();
    await expect(basic).toHaveAttribute("title", /mixes AND and OR \(col \d+\)/);
    await expect(page.getByRole("button", { name: "CQL", exact: true })).toHaveAttribute("aria-pressed", "true");
  });
});
