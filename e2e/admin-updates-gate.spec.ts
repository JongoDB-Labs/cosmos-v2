import { test, expect } from "./fixtures/auth";

/**
 * The instance-wide Updates surface must not open to an ordinary org user.
 *
 * WHY THIS IS THE E2E-SHAPED TEST. The panel's rendering is already covered by
 * component tests, which drive it far faster and in more states than a browser
 * can. What they CANNOT cover is the thing that only exists end to end: a real
 * session, real cookies, and the server deciding whether this person may see an
 * instance-wide control at all. That decision is the security-relevant half.
 *
 * WHY IT ASSERTS DENIAL RATHER THAN THE HAPPY PATH. `/admin/*` is gated on
 * `requireSystemAdmin()` — the INTERNAL_ADMINS allowlist — which is deliberately
 * NOT satisfied by "owner of any org", because self-service org creation mints
 * OWNER and gating an instance-wide control on it would be an escalation path.
 * INTERNAL_ADMINS is not set for the e2e job, so no seeded user is a system
 * admin, and the reachable, meaningful assertion is that the gate holds.
 *
 * That is not a consolation prize: an over-permissive gate is the failure that
 * actually matters here, and this is the only layer that can catch it.
 *
 * Read-only. Visits two routes and mutates nothing, so it is safe against the
 * shared CI database and seed.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("instance Updates surface — access control", () => {
  test("a signed-in org user is redirected away from /admin/updates", async ({
    page,
    signInAs,
  }) => {
    await signInAs(EMAIL);
    await page.goto("/admin/updates");
    await page.waitForLoadState("networkidle");

    // The page must not land on the admin route...
    expect(page.url()).not.toContain("/admin/updates");
    // ...and must not leak the surface's own copy, which would mean it rendered
    // before redirecting.
    await expect(page.locator("body")).not.toContainText("Application version");
    await expect(page.locator("body")).not.toContainText("Check for updates");
  });

  test("the update-check API refuses an ordinary org user", async ({ page, signInAs }) => {
    await signInAs(EMAIL);

    const res = await page.request.get("/api/v1/admin/updates");
    expect(res.status()).toBeGreaterThanOrEqual(400);

    // Whatever the refusal looks like, it must carry no update intelligence:
    // an authenticated non-admin should learn nothing about the registry, the
    // running version, or what is available.
    const body = await res.text();
    expect(body).not.toContain("candidateDigest");
    expect(body).not.toContain("preflights");
    expect(body).not.toContain("updateAvailable");
  });

  test("an anonymous visitor gets nothing from either route", async ({ page }) => {
    // No signInAs — deliberately unauthenticated.
    const api = await page.request.get("/api/v1/admin/updates");
    expect(api.status()).toBeGreaterThanOrEqual(400);

    await page.goto("/admin/updates");
    await page.waitForLoadState("networkidle");
    expect(page.url()).not.toContain("/admin/updates");
  });
});

test.describe("the org surface is unaffected by the admin route", () => {
  test("a normal org page still renders for the same user", async ({ page, signInAs }) => {
    // Guards against a gate that is over-broad: redirecting /admin/* must not
    // come at the cost of the ordinary surfaces the same session can use.
    await signInAs(EMAIL);
    await page.goto(`/${ORG}/settings/profile`);
    await expect(page.locator("main").first()).toBeVisible();
  });
});
