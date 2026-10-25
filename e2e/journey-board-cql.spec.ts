import { test, expect } from "./fixtures/auth";
import { openIssues, resetQueryLanguage, setQueryLanguage } from "./fixtures/issues-query";
import { runAxe, blocking } from "./fixtures/axe";

/**
 * Boards on the query language (query design §12.1, §14.3): save an Issues
 * query as a board, the board opens with that query as its scope, the bar
 * narrows within it, and Clear returns to the scope.
 *
 * The seeded FAL project has three items: "Falcon radar upgrade", "Falcon
 * telemetry pipeline" and "Falcon SSO integration", all MEDIUM.
 */
test.describe("Boards — query language", () => {
  test.afterAll(async ({ browser }) => {
    await resetQueryLanguage(browser);
  });

  test("save as board → the board's scope applies → narrow it → Clear returns to the scope", async ({ page, signInAs, baseURL }) => {
    test.setTimeout(120_000);
    const base = baseURL ?? "http://localhost:3000";
    const name = `Radar board ${Date.now()}`;
    await signInAs("alice@test.local");
    await setQueryLanguage(page.request, true);
    await openIssues(page, { cql: 'project = FAL AND summary ~ "radar"', mode: "advanced" });
    await expect(page.getByRole("cell", { name: "Falcon radar upgrade" })).toBeVisible({ timeout: 20_000 });

    // Save it as a board in FAL.
    const save = page.getByRole("button", { name: "Save as board" });
    await expect(save).toBeEnabled({ timeout: 10_000 });
    await save.click();
    const dialog = page.getByRole("dialog", { name: "Save as board" });
    await dialog.getByLabel("Board name").fill(name);
    await dialog.getByRole("combobox", { name: "Target project" }).click();
    await page.getByRole("option", { name: /^FAL/ }).click();
    // A Table: a Kanban created this way has no columns yet (POST /boards seeds none).
    await dialog.getByRole("combobox", { name: "Board type" }).click();
    await page.getByRole("option", { name: /^Table/ }).click();
    await dialog.getByRole("button", { name: "Create board" }).click();
    await expect(page).toHaveURL(/\/projects\/FAL\/boards\//, { timeout: 20_000 });
    const boardUrl = page.url();

    // The board's scope is the saved query (its project pin dropped), and only its card shows.
    await expect(page.getByText('This board shows summary ~ "radar"')).toBeVisible({ timeout: 20_000 });
    const card = (title: string) => page.getByRole("cell", { name: title });
    await expect(card("Falcon radar upgrade")).toBeVisible({ timeout: 20_000 });
    await expect(card("Falcon telemetry pipeline")).toBeHidden();

    // The table board itself passes axe (its toolbar "Group by" select was unnamed).
    await expect(page.getByRole("combobox", { name: "Group by:" })).toBeVisible();
    expect(blocking(await runAxe(page))).toEqual([]);

    // Narrow within it from the bar: nothing is HIGH.
    await page.goto(`${boardUrl}?cql=${encodeURIComponent("priority = HIGH")}&mode=advanced`);
    await expect(page.getByText('This board shows summary ~ "radar"')).toBeVisible({ timeout: 20_000 });
    await expect(card("Falcon radar upgrade")).toBeHidden({ timeout: 20_000 });

    // Clear returns to the board's scope, not to every item in the project.
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(card("Falcon radar upgrade")).toBeVisible({ timeout: 20_000 });
    await expect(card("Falcon SSO integration")).toBeHidden();
    expect(new URL(page.url()).searchParams.get("cql")).toBeNull();

    // Tidy up: delete the board.
    const orgs = await (await page.request.get("/api/v1/orgs")).json();
    const org = ((orgs.data ?? orgs) as { id: string; slug: string }[]).find((o) => o.slug === "test-org")!;
    const projects = await (await page.request.get(`/api/v1/orgs/${org.id}/projects`)).json();
    const fal = ((projects.data ?? projects) as { id: string; key: string }[]).find((p) => p.key === "FAL")!;
    const boards = await (await page.request.get(`/api/v1/orgs/${org.id}/projects/${fal.id}/boards`)).json();
    const mine = ((boards.data ?? boards) as { id: string; name: string }[]).find((b) => b.name === name);
    if (mine) await page.request.delete(`/api/v1/orgs/${org.id}/projects/${fal.id}/boards/${mine.id}`, { headers: { Origin: base } });
  });
});
