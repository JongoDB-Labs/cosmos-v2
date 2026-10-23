import { test, expect } from "./fixtures/auth";
import { openIssues, resetQueryLanguage, setQueryLanguage } from "./fixtures/issues-query";

/**
 * Filter subscriptions (query design §12.4, §14.3): save a filter, subscribe to
 * it weekly at a chosen time, see it listed with its schedule, pause it, then
 * remove it.
 *
 * What the emails contain, who receives which rows, the once-per-schedule run
 * and the unsubscribe link are covered against a real database in
 * src/lib/query/__tests__/subscriptions.db.test.ts (e2e sets JOBS_DISABLED,
 * and sends no mail).
 */
test.describe("Issues — filter subscriptions", () => {
  test.afterAll(async ({ browser }) => {
    await resetQueryLanguage(browser);
  });

  test("subscribe to a saved filter, see the schedule, pause, remove", async ({ page, signInAs, baseURL }) => {
    test.setTimeout(120_000);
    const base = baseURL ?? "http://localhost:3000";
    const name = `FAL radar digest ${Date.now()}`;
    await signInAs("alice@test.local");
    await setQueryLanguage(page.request, true);
    await openIssues(page, { cql: 'project = FAL AND summary ~ "radar"', mode: "advanced" });

    await page.getByRole("button", { name: "Save filter" }).click();
    const save = page.getByRole("dialog", { name: "Save filter" });
    await save.getByLabel("Name").fill(name);
    await save.getByRole("button", { name: "Save" }).click();
    await expect(save).toBeHidden();
    await expect.poll(() => new URL(page.url()).searchParams.get("filter")).not.toBeNull();
    const filterId = new URL(page.url()).searchParams.get("filter")!;

    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("menuitem", { name }).and(page.locator("[aria-haspopup]")).hover();
    await page.getByRole("menuitem", { name: "Subscribe…" }).click();

    const dialog = page.getByRole("dialog", { name: `Subscribe to “${name}”` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "When" }).click();
    await page.getByRole("option", { name: "Once a week" }).click();
    await dialog.getByRole("combobox", { name: "Day of the week" }).click();
    await page.getByRole("option", { name: "Friday" }).click();
    await dialog.getByLabel("At", { exact: true }).fill("09:15");
    await expect(dialog.getByText(/^Next: /)).toBeVisible();
    await dialog.getByRole("button", { name: "Subscribe" }).click();

    const list = dialog.getByRole("list", { name: "Subscriptions" });
    await expect(list.getByText(/Every Friday at 09:15/)).toBeVisible({ timeout: 10_000 });
    await list.getByRole("button", { name: "Pause" }).click();
    await expect(list.getByText(/Off: paused/)).toBeVisible({ timeout: 10_000 });
    await list.getByRole("button", { name: /^Remove subscription/ }).click();
    await expect(list).toBeHidden({ timeout: 10_000 });

    // Tidy up: delete the filter.
    const orgs = await (await page.request.get("/api/v1/orgs")).json();
    const org = ((orgs.data ?? orgs) as { id: string; slug: string }[]).find((o) => o.slug === "test-org")!;
    await page.request.delete(`/api/v1/orgs/${org.id}/saved-views/${filterId}`, { headers: { Origin: base } });
  });
});
