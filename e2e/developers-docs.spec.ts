import { test, expect } from "./fixtures/auth";
import { mintToken, orgIdForSlug, revokeTokensNamed } from "./fixtures/tokens";

/**
 * /developers: the guides, the reference (Scalar) and try-it.
 *
 * The try-it test is the one only a browser can run: Scalar's own fetch would
 * send the session cookie, so the cookie (not the token on screen) would
 * authorize the call. We hand it a fetch that omits credentials; this asserts
 * the request that actually leaves the page carries the token and no cookie.
 *
 * Mints read-only tokens for the signed-in user and revokes them after. Reads
 * only otherwise.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const TRY_IT_NAME = "API docs try-it";

test.describe("developer docs", () => {
  test.afterEach(async ({ page, baseURL }) => {
    await revokeTokensNamed(page.request, baseURL, TRY_IT_NAME);
    await revokeTokensNamed(page.request, baseURL, "e2e developers");
  });

  test("guides render, and a problem's type links to its section", async ({ page, signInAs }) => {
    await signInAs(EMAIL);
    await page.goto("/developers");
    await expect(page.getByRole("heading", { name: "Guides" })).toBeVisible();
    await page.getByRole("link", { name: /^Quickstart/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Quickstart" })).toBeVisible();

    await page.goto("/developers/guides/errors#not_found");
    await expect(page.locator("#not_found")).toBeVisible();
  });

  test("try-it sends the test token and never the session cookie", async ({ page, signInAs }) => {
    test.setTimeout(120_000);
    await signInAs(EMAIL);
    await page.goto("/developers/reference");

    await page.getByRole("button", { name: "Create a 1-hour read-only test token" }).click();
    await expect(page.getByTestId("try-it-token")).toContainText("cosmos_");

    // Scalar's sidebar: open the Projects tag, then the operation.
    await page.getByRole("button", { name: "Open Group - Projects" }).click();
    await page.getByRole("link", { name: /^List projects HTTP Method: GET/ }).click();
    const section = page
      .locator("section", { has: page.getByRole("heading", { name: "List projects", exact: true }) })
      .last();
    await section.getByRole("button", { name: /Test Request/i }).first().click();

    const sent = page.waitForRequest((r) => /\/api\/v1\/orgs\/[^/]+\/projects/.test(r.url()));
    await page.getByRole("button", { name: /^Send/ }).first().click();
    const request = await sent;
    const headers = await request.allHeaders();
    expect(headers.authorization).toMatch(/^Bearer cosmos_/);
    expect(headers.cookie).toBeUndefined();
    // {orgId} was pre-filled with the token's org, so the call succeeds.
    expect((await request.response())?.status()).toBe(200);
  });

  test("a read token can fetch the spec it was documented by", async ({ page, signInAs, baseURL, playwright }) => {
    await signInAs(EMAIL);
    const orgId = await orgIdForSlug(page.request, ORG);
    const { token } = await mintToken(page.request, baseURL, { orgId, name: "e2e developers", scopes: ["read"] });

    // A fresh context: no session cookie, only the token.
    const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    const spec = await api.get("/api/v1/openapi.json");
    expect(spec.status()).toBe(200);
    expect((await spec.json()).paths["/orgs/{orgId}/projects"]).toBeTruthy();
    const me = await api.get("/api/v1/me");
    expect((await me.json()).token).toMatchObject({ orgId, scopes: ["read"], kind: "PERSONAL" });
    await api.dispose();
  });
});
