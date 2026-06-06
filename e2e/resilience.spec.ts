import { test, expect } from "./fixtures/auth";

/**
 * Resilience regression — locks in the R20/R21 convention (notifyError /
 * LoadError): a failed data load must surface a clear, RECOVERABLE error, never
 * a silent blank or a stuck skeleton. Route interception forces the failure, so
 * the real API/DB is never touched (intercepted requests don't go out).
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

// Data surfaces whose primary load is fronted by a <LoadError> failed state.
// `api` is the glob for that primary fetch; failing it should reveal LoadError.
const SURFACES: Array<{ name: string; path: string; api: string }> = [
  { name: "time-tracking", path: "/time-tracking", api: "**/api/v1/orgs/*/time-entries*" },
  { name: "finance", path: "/finance", api: "**/api/v1/orgs/*/finance/**" },
  { name: "analytics", path: "/analytics", api: "**/api/v1/orgs/*/analytics/portfolio*" },
  { name: "meetings", path: "/meetings", api: "**/api/v1/orgs/*/meetings*" },
  { name: "compliance", path: "/settings/compliance", api: "**/api/v1/orgs/*/compliance/**" },
  { name: "integrations", path: "/settings/integrations", api: "**/api/v1/orgs/*/integrations*" },
  { name: "audit-logs", path: "/settings/audit-logs", api: "**/api/v1/orgs/*/audit-logs*" },
  // mcp-servers omitted: its manager doesn't issue the intercepted load in the
  // bare test org, so there's no failure to surface here (verify separately).
];

test.describe("resilience — failed loads surface a recoverable error", () => {
  for (const s of SURFACES) {
    test(`${s.name}: failed load shows a recoverable LoadError`, async ({
      page,
      signInAs,
    }) => {
      // Some surfaces load via React Query, which retries a 500 (with backoff)
      // before surfacing the error — give those room.
      test.setTimeout(45_000);
      await signInAs(EMAIL);
      await page.route(s.api, (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "boom" }),
        }),
      );
      await page.goto(`/${ORG}${s.path}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("main", { timeout: 20_000 });

      // The recoverable-error affordance (LoadError renders a "Try again" button).
      await expect(
        page.getByRole("button", { name: /try again/i }),
        `${s.name} should show a recoverable LoadError when its load fails`,
      ).toBeVisible({ timeout: 25_000 });
    });
  }

  test("time-tracking: retry recovers after the load succeeds", async ({
    page,
    signInAs,
  }) => {
    await signInAs(EMAIL);
    let fail = true;
    await page.route("**/api/v1/orgs/*/time-entries*", async (route) => {
      if (fail) {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "boom" }),
        });
      }
      return route.continue();
    });
    await page.goto(`/${ORG}/time-tracking`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });

    const retry = page.getByRole("button", { name: /try again/i });
    await expect(retry).toBeVisible({ timeout: 15_000 });

    // Recovery path: let the next load succeed, retry, and the error clears.
    fail = false;
    await retry.click();
    await expect(retry).toBeHidden({ timeout: 15_000 });
  });
});
