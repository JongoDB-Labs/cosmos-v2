import { test, expect } from "./fixtures/auth";
import { editor, openIssues, resetQueryLanguage, runCql, setQueryLanguage, urlCql } from "./fixtures/issues-query";

/**
 * Issues with the query language on (query design §14.3): write a query with
 * completion, run it, and the URL carries it through a reload; Basic shows the
 * same query as chips, and removing one updates the URL and the rows.
 */
test.describe("Issues — query language", () => {
  test.afterAll(async ({ browser }) => {
    await resetQueryLanguage(browser);
  });

  test("Advanced: completion, run, shareable URL, then the same query as chips", async ({ page, signInAs }) => {
    test.setTimeout(90_000);
    await signInAs("alice@test.local");
    await setQueryLanguage(page.request, true);
    await openIssues(page, { mode: "advanced" });

    // Completion offers fields as you type; Enter accepts, then the operator list opens.
    const ed = editor(page);
    await ed.click();
    await ed.pressSequentially("proj", { delay: 30 });
    const list = page.getByRole("listbox");
    await expect(list.getByRole("option", { name: /^project/ })).toBeVisible();
    await page.keyboard.press("Enter");
    // Only the operators `project` takes: no `~`, no `<`.
    await expect(list).toContainText("NOT IN ()");
    await expect(list).not.toContainText("~");
    await page.keyboard.press("Escape");

    await runCql(page, 'project = FAL AND summary ~ "telemetry"');
    await expect(page.getByRole("cell", { name: "Falcon telemetry pipeline" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("cell", { name: "Falcon radar upgrade" })).toHaveCount(0);
    expect(urlCql(page)).toBe('project = FAL AND summary ~ "telemetry"');

    // The URL is the query: a reload (or a pasted link) shows the same rows.
    await page.reload();
    await expect(page.getByRole("cell", { name: "Falcon telemetry pipeline" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("cell", { name: "Falcon radar upgrade" })).toHaveCount(0);

    // Basic shows it as two chips; removing one widens the result.
    await page.getByRole("button", { name: "Basic" }).click();
    await expect(page.getByRole("group", { name: "Filter: Project" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Filter: Summary" })).toBeVisible();
    await page.getByRole("button", { name: "Remove filter: Summary" }).click();
    await expect.poll(() => urlCql(page)).toBe("project = FAL");
    await expect(page.getByRole("cell", { name: "Falcon radar upgrade" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("cell", { name: "Falcon SSO integration" })).toBeVisible();
  });

  test("Basic: the search box and the Watching toggle write the query", async ({ page, signInAs }) => {
    test.setTimeout(60_000);
    await signInAs("alice@test.local");
    await setQueryLanguage(page.request, true);
    await openIssues(page, { cql: "project = FAL", mode: "basic" });

    const box = page.getByRole("textbox", { name: "Search issues" });
    await box.fill("radar");
    await box.press("Enter");
    await expect.poll(() => urlCql(page)).toBe('project = FAL AND text ~ "radar"');
    await expect(page.getByRole("cell", { name: "Falcon radar upgrade" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("cell", { name: "Falcon SSO integration" })).toHaveCount(0);

    await page.getByRole("button", { name: /Watching/ }).click();
    await expect.poll(() => urlCql(page)).toBe('project = FAL AND text ~ "radar" AND watcher = me');
    await expect(page.getByRole("button", { name: /Watching/ })).toHaveAttribute("aria-pressed", "true");
  });
});
