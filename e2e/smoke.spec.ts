import { test, expect } from "@playwright/test";

/**
 * Smoke test for the login gate. The full auth flow requires an actual
 * Google OAuth session, which we mock in a follow-up CI integration test
 * — for now this asserts the unauthenticated experience renders cleanly
 * and the marketing/login chrome doesn't 5xx.
 */

test.describe("login gate", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    const response = await page.goto("/");
    expect(response).toBeTruthy();
    // The proxy 302s to /login when no session cookie is present.
    await expect(page).toHaveURL(/\/login(\?.*)?$/);
  });

  test("/login renders without crashing and shows Google CTA", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /google/i })).toBeVisible();
  });

  test("health endpoint returns OK", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBe(true);
  });

  test("dashboard route returns redirect when not authed", async ({
    request,
  }) => {
    // Don't follow the redirect — just verify the gate fires.
    const res = await request.get("/", { maxRedirects: 0 }).catch((e) => e);
    // Either a 30x redirect surface or thrown by playwright due to redirects;
    // either way we should not see a 200 body containing dashboard chrome.
    if (res && typeof res.status === "function") {
      const s = res.status();
      expect([302, 307, 308]).toContain(s);
    }
  });
});
