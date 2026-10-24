import { test, expect } from "./fixtures/auth";
import { openIssues, resetQueryLanguage, runCql, setQueryLanguage } from "./fixtures/issues-query";

/**
 * Query history (query design §3.6, phase 4): edit an item the ordinary way,
 * then find it by what changed. Exercises the whole path: the work-item PUT
 * records Activity, and WAS / CHANGED read it back, typed in the editor.
 */
test.describe("Issues — query history", () => {
  test.afterAll(async ({ browser }) => {
    await resetQueryLanguage(browser);
  });

  test("CHANGED and WAS find an item by the edit just made", async ({ page, signInAs, baseURL }) => {
    test.setTimeout(90_000);
    const base = baseURL ?? "http://localhost:3000";
    await signInAs("alice@test.local");
    await setQueryLanguage(page.request, true);

    const orgs = await (await page.request.get("/api/v1/orgs")).json();
    const org = ((orgs.data ?? orgs) as { id: string; slug: string }[]).find((o) => o.slug === "test-org")!;
    const found = await (
      await page.request.get(`/api/v1/orgs/${org.id}/work-items/search?cql=${encodeURIComponent('project = FAL AND summary ~ "telemetry"')}`)
    ).json();
    const item = ((found.data ?? found) as { id: string; project: { id: string } }[])[0];
    expect(item).toBeTruthy();
    const put = (priority: string) =>
      page.request.put(`/api/v1/orgs/${org.id}/projects/${item.project.id}/work-items/${item.id}`, {
        data: { priority },
        headers: { Origin: base },
      });

    // Assert on each query's own results: the unfiltered list already shows the item.
    const run = async (cql: string): Promise<string[]> => {
      const searched = page.waitForResponse(
        (r) => r.url().includes("/work-items/search") && new URL(r.url()).searchParams.get("cql") === cql,
      );
      await runCql(page, cql);
      const res = await searched;
      expect(res.ok()).toBe(true);
      const body = await res.json();
      return ((body.data ?? body) as { title: string }[]).map((r) => r.title);
    };

    // Only this run's edits count: the window opens now (earlier runs left history too).
    const since = new Date(Date.now() - 1000).toISOString();
    expect((await put("HIGH")).ok()).toBe(true);
    try {
      await openIssues(page, { mode: "advanced" });
      expect(await run(`project = FAL AND priority CHANGED FROM MEDIUM TO HIGH BY me AFTER "${since}"`)).toEqual(["Falcon telemetry pipeline"]);
      await expect(page.getByRole("cell", { name: "Falcon radar upgrade" })).toBeHidden();
      await expect(page.getByRole("cell", { name: "Falcon telemetry pipeline" })).toBeVisible();

      // Was MEDIUM when the window opened, is HIGH now: the "raised" query.
      expect(await run(`project = FAL AND priority WAS MEDIUM ON "${since}" AND priority = HIGH`)).toEqual(["Falcon telemetry pipeline"]);
    } finally {
      // Put it back; the seeded FAL items are all MEDIUM.
      expect((await put("MEDIUM")).ok()).toBe(true);
    }
  });
});
