import { expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

/**
 * Shared helpers for the Issues query language (CQL) specs.
 *
 * The beta is a per-org switch (Settings → Organization → "Query language
 * (beta)"), off by default, so every spec that needs it turns it on through
 * the same API the switch uses, and turns it back off when done: the other
 * Issues specs were written against the legacy filter bar.
 *
 * The seeded "Falcon Program" (FAL) project has exactly three items, all
 * MEDIUM and unassigned: "Falcon radar upgrade", "Falcon telemetry pipeline"
 * and "Falcon SSO integration" (prisma/seed/test-fixtures.ts).
 */
export const ORG_SLUG = "test-org";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

async function orgId(request: APIRequestContext): Promise<string> {
  const r = await request.get(`${BASE}/api/v1/orgs`);
  if (!r.ok()) throw new Error(`GET /api/v1/orgs failed: ${r.status()}`);
  const j = await r.json();
  const orgs: { id: string; slug: string }[] = j.data ?? j;
  const org = orgs.find((o) => o.slug === ORG_SLUG);
  if (!org) throw new Error(`org "${ORG_SLUG}" not found`);
  return org.id;
}

/** Turn the query language on or off for test-org. The request must be signed in as an admin (alice). */
export async function setQueryLanguage(request: APIRequestContext, enabled: boolean): Promise<void> {
  const id = await orgId(request);
  // Origin: the proxy's same-origin CSRF check (an API context sends none).
  const r = await request.put(`${BASE}/api/v1/orgs/${id}/query-language`, { data: { enabled }, headers: { Origin: BASE } });
  if (!r.ok()) throw new Error(`PUT query-language failed: ${r.status()} ${await r.text()}`);
}

/** Open Issues, optionally with a query and mode, and wait for the query bar. */
export async function openIssues(page: Page, opts: { cql?: string; mode?: "basic" | "advanced" } = {}) {
  const qs = new URLSearchParams();
  if (opts.cql) qs.set("cql", opts.cql);
  if (opts.mode) qs.set("mode", opts.mode);
  await page.goto(`/${ORG_SLUG}/issues${qs.size ? `?${qs}` : ""}`);
  await expect(page.getByRole("group", { name: "How to filter" })).toBeVisible({ timeout: 30_000 });
}

/** The CodeMirror editor (CQL mode). */
export function editor(page: Page) {
  return page.getByRole("textbox", { name: "Query" });
}

/** Replace the CQL editor's text and run it. */
export async function runCql(page: Page, text: string) {
  const ed = editor(page);
  await ed.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await ed.pressSequentially(text, { delay: 10 });
  await page.keyboard.press("Escape"); // close any completion list
  await page.getByRole("button", { name: "Run query" }).click();
}

/** Rows of the Issues table (by title), once the result for the current URL has landed. */
export async function rowTitles(page: Page): Promise<string[]> {
  const rows = page.getByRole("row");
  await expect(rows.first()).toBeVisible();
  return (await page.getByRole("cell").filter({ hasText: /^Falcon / }).allTextContents()).map((t) => t.trim());
}

/** The `cql` param of the current URL. */
export function urlCql(page: Page): string | null {
  return new URL(page.url()).searchParams.get("cql");
}

/** Switch the beta off again from a fresh admin session (for afterAll, which has no page). */
export async function resetQueryLanguage(browser: Browser): Promise<void> {
  const ctx = await browser.newContext();
  try {
    const r = await ctx.request.post(`${BASE}/api/testenv/sign-in`, { data: { email: "alice@test.local" }, headers: { Origin: BASE } });
    if (!r.ok()) throw new Error(`test sign-in failed: ${r.status()}`);
    await setQueryLanguage(ctx.request, false);
  } finally {
    await ctx.close();
  }
}
