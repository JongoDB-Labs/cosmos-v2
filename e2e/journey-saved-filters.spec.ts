import { test, expect } from "./fixtures/auth";
import { editor, openIssues, resetQueryLanguage, setQueryLanguage, urlCql } from "./fixtures/issues-query";

/**
 * Saved filters (query design §10, §14.3): save a query shared with a project,
 * star it into the sidebar, see it from a second account that reads the
 * project, change it and save the change through the "Filter changed" bar.
 *
 * The "who must NOT see it" half (team-scoped projects, ABAC, other orgs)
 * needs accounts this seed doesn't have; it is covered against a real
 * database in src/lib/query/__tests__/saved-filters.db.test.ts.
 */
test.describe("Issues — saved filters", () => {
  test.afterAll(async ({ browser }) => {
    await resetQueryLanguage(browser);
  });

  test("save to a project, star it, a project reader sees it, edit and save the change", async ({ page, signInAs, browser, baseURL }) => {
    test.setTimeout(120_000);
    const name = `FAL radar ${Date.now()}`;
    await signInAs("alice@test.local");
    await setQueryLanguage(page.request, true);
    await openIssues(page, { cql: 'project = FAL AND text ~ "radar"', mode: "advanced" });
    await expect(page.getByRole("cell", { name: "Falcon radar upgrade" })).toBeVisible({ timeout: 20_000 });

    // Save it, shared with the project.
    await page.getByRole("button", { name: "Save filter" }).click();
    const dialog = page.getByRole("dialog", { name: "Save filter" });
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByRole("radio", { name: /A project/ }).check();
    await dialog.getByRole("combobox", { name: "Project" }).click();
    await page.getByRole("option", { name: /^FAL/ }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    // Saving loads it: the URL names the filter, and runs it by id.
    await expect.poll(() => new URL(page.url()).searchParams.get("filter")).not.toBeNull();
    const filterId = new URL(page.url()).searchParams.get("filter")!;
    expect(urlCql(page)).toBeNull();
    await expect(page.getByRole("cell", { name: "Falcon radar upgrade" })).toBeVisible({ timeout: 20_000 });

    // Star it: it appears under Issues in the sidebar.
    await page.getByRole("button", { name: "Saved filters", exact: true }).click();
    // The row under My filters (it is also under Recently used, which only runs).
    await page.getByRole("menuitem", { name }).and(page.locator("[aria-haspopup]")).hover();
    await page.getByRole("menuitem", { name: "Star" }).click();
    const starred = page.getByRole("list", { name: "Starred filters" });
    await expect(starred.getByRole("link", { name })).toBeVisible({ timeout: 10_000 });

    // Bob reads FAL, so it's under Shared with me → Your projects.
    const bobCtx = await browser.newContext({ baseURL });
    const bob = await bobCtx.newPage();
    const r = await bob.request.post(`${baseURL ?? "http://localhost:3000"}/api/testenv/sign-in`, {
      data: { email: "bob@test.local" },
      headers: { Origin: baseURL ?? "http://localhost:3000" },
    });
    expect(r.ok()).toBe(true);
    await openIssues(bob);
    await bob.getByRole("button", { name: "Saved filters", exact: true }).click();
    await expect(bob.getByText("Your projects")).toBeVisible();
    await expect(bob.getByRole("menuitem", { name }).first()).toBeVisible();
    await bobCtx.close();

    // Change it: the bar appears; Save writes it and the bar goes away.
    const ed = editor(page);
    await ed.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await ed.pressSequentially("project = FAL", { delay: 10 });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Run query" }).click();
    const bar = page.getByRole("status").filter({ hasText: "Filter changed" });
    await expect(bar).toBeVisible();
    await bar.getByRole("button", { name: "Save", exact: true }).click();
    await expect(bar).toBeHidden({ timeout: 10_000 });
    const saved = await page.request.get(`/api/v1/orgs/${await orgIdOf(page)}/saved-views/${filterId}`);
    const j = (await saved.json()) as { data?: { cql: string }; cql?: string };
    expect((j.data ?? j).cql).toBe("project = FAL");

    // Tidy up.
    await page.request.delete(`/api/v1/orgs/${await orgIdOf(page)}/saved-views/${filterId}`, { headers: { Origin: baseURL ?? "http://localhost:3000" } });
  });
});

async function orgIdOf(page: import("@playwright/test").Page): Promise<string> {
  const j = await (await page.request.get("/api/v1/orgs")).json();
  const orgs: { id: string; slug: string }[] = j.data ?? j;
  return orgs.find((o) => o.slug === "test-org")!.id;
}
