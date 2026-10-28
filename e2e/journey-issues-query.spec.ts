import { test, expect } from "./fixtures/auth";
import { editor, openIssues, resetQueryLanguage, runCql, setQueryLanguage, urlCql } from "./fixtures/issues-query";

/**
 * Issues with the query language on (query design §14.3): write a query with
 * completion, run it, and the URL carries it through a reload; Filters shows the
 * same query as chips, and removing one updates the URL and the rows.
 */
test.describe("Issues — query language", () => {
  test.afterAll(async ({ browser }) => {
    await resetQueryLanguage(browser);
  });

  test("CQL: completion, run, shareable URL, then the same query as chips", async ({ page, signInAs }) => {
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

    // Filters shows it as two chips; removing one widens the result.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await expect(page.getByRole("group", { name: "Filter: Project" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Filter: Summary" })).toBeVisible();
    await page.getByRole("button", { name: "Remove filter: Summary" }).click();
    await expect.poll(() => urlCql(page)).toBe("project = FAL");
    await expect(page.getByRole("cell", { name: "Falcon radar upgrade" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("cell", { name: "Falcon SSO integration" })).toBeVisible();
  });

  test("Filters: the search box and the Watching toggle write the query", async ({ page, signInAs }) => {
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

  // FR ad579c82: "i should simply be able to add the filters from the dropdown
  // on the right or search/save filters in the search bar".
  test("Add filter works beside the CQL editor, on a query chips can't show", async ({ page, signInAs }) => {
    test.setTimeout(60_000);
    await signInAs("alice@test.local");
    await setQueryLanguage(page.request, true);
    // Mixes AND and OR, so chips refuse it — which is exactly the case that
    // used to leave the bar with no way to add a filter at all.
    const base = "type IN (BUG) OR (priority = HIGH AND points > 3)";
    await openIssues(page, { cql: base, mode: "basic" });
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeDisabled();

    const add = page.getByRole("combobox", { name: "Add filter" });
    await expect(add).toBeVisible();
    await add.click();
    await page.getByRole("option", { name: "Assignee: me" }).click();

    // The query it could not show is kept WHOLE, in parentheses, and the new
    // clause is ANDed on: binding it to the OR's last arm would change what
    // the page shows.
    await expect.poll(() => urlCql(page), { timeout: 15_000 }).toMatch(/^\(.+\) AND assignee = me$/);
    expect(urlCql(page)).toContain("type IN (BUG)");
  });

  test("the search box offers a saved filter whose name matches", async ({ page, signInAs }) => {
    test.setTimeout(90_000);
    const name = `Radar probe ${Date.now()}`;
    await signInAs("alice@test.local");
    await setQueryLanguage(page.request, true);
    await openIssues(page, { cql: 'project = FAL AND text ~ "radar"', mode: "advanced" });

    await page.getByRole("button", { name: "Save filter" }).click();
    const dialog = page.getByRole("dialog", { name: "Save filter" });
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => new URL(page.url()).searchParams.get("filter")).not.toBeNull();

    // Back to an empty query, in chips, and type the filter's name where the
    // reporter typed it: the search box, which otherwise searches issue TEXT
    // and would find nothing while saying nothing about why.
    await openIssues(page, { mode: "basic" });
    await page.getByRole("textbox", { name: "Search issues" }).fill("Radar probe");
    const hit = page.getByRole("button", { name, exact: true });
    await expect(hit).toBeVisible({ timeout: 15_000 });
    await hit.click();

    await expect.poll(() => new URL(page.url()).searchParams.get("filter")).not.toBeNull();
    await expect(page.getByRole("cell", { name: "Falcon radar upgrade" })).toBeVisible({ timeout: 20_000 });
  });
});
