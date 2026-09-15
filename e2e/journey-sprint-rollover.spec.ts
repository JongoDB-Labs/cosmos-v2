import { test, expect } from "./fixtures/auth";
import type { Page } from "@playwright/test";

/**
 * E2E journey — completing a sprint rolls into the one already planned.
 *
 * Reported as "two Sprint 2s". `startNextSprint()` had exactly one path and it
 * POSTed, so completing Sprint 1 and accepting the pre-filled "Sprint 2" created
 * a SECOND Sprint 2 and activated that, leaving the real one PLANNED and
 * untouched. Because `Interval.number` is `max + 1` and stays unique, it read as
 * a rendering bug rather than two rows — which is what made it hard to report.
 *
 * This spec CREATES ITS OWN PROJECT. Only one non-PI interval may be ACTIVE at a
 * time, so running against the shared TEST project would depend on whether some
 * earlier spec left a sprint running — the test would pass or fail on execution
 * order rather than on behaviour. A fresh project has no intervals at all.
 *
 * The assertion that matters is the interval COUNT, read from the API rather
 * than the screen: the bug created a row, and a duplicate row is invisible in a
 * list where both entries look identical.
 *
 * Mutating — runs in the CI e2e job. Unique project key per run so a retry on
 * the shared CI database cannot collide.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

const STAMP = Date.now().toString().slice(-6);
const PROJECT_NAME = `E2E Rollover ${STAMP}`;
const PROJECT_KEY = `ROLL${STAMP}`;
const SPRINT_A = "Sprint 1";
const SPRINT_B = "Sprint 2";

/**
 * `page.goto` that tolerates the transient `net::ERR_ABORTED` `next dev` throws
 * when a streaming navigation races a cacheComponents tag revalidation — e.g.
 * loading /projects right after a create hard-expires its cache tag.
 */
async function gotoStable(
  page: Page,
  url: string,
  opts?: Parameters<Page["goto"]>[1],
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, opts);
      return;
    } catch (e) {
      if (attempt >= 4 || !String(e).includes("ERR_ABORTED")) throw e;
      await page.waitForTimeout(500);
    }
  }
}

async function createProject(page: Page) {
  await gotoStable(page, `/${ORG}/projects`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("main", { timeout: 20_000 });

  await page
    .getByRole("link", { name: /new project/i })
    .or(page.getByRole("button", { name: /create project/i }))
    .first()
    .click();
  await page.waitForURL(/\/projects\/new/, { timeout: 15_000 });

  await page.getByRole("button", { name: /start from scratch/i }).first().click();

  // Gate on a single instance — the step transition briefly double-renders.
  const nameInput = page.getByLabel(/^Project name/i);
  await expect(nameInput).toHaveCount(1, { timeout: 15_000 });
  await nameInput.fill(PROJECT_NAME);
  await page.getByLabel(/^Project key/i).fill(PROJECT_KEY);
  await page.getByRole("button", { name: /create project/i }).click();

  await expect(page).toHaveURL(
    new RegExp(`/${ORG}/projects/${PROJECT_KEY.toLowerCase()}`),
    { timeout: 25_000 },
  );
}

async function planSprint(page: Page, name: string, start: string, end: string) {
  await gotoStable(page, `/${ORG}/projects/${PROJECT_KEY.toLowerCase()}/intervals`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("main", { timeout: 20_000 });

  await page.getByRole("button", { name: /new interval/i }).first().click();
  await expect(
    page.getByRole("heading", { name: /plan an interval/i }),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByLabel(/^Name$/).fill(name);
  await page.getByLabel(/start date/i).fill(start);
  await page.getByLabel(/end date/i).fill(end);
  await page.getByRole("button", { name: /create interval/i }).click();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
}

/**
 * The project's intervals straight from the API — the screen cannot tell two
 * identically-named sprints apart, which is the entire bug.
 *
 * The endpoint is addressed by org and project UUIDs, which the URL bar does not
 * carry (it uses slugs). Rather than resolve them, reuse the exact URL the
 * workspace itself just fetched — captured from the page's own traffic, so it
 * cannot drift from what the app actually calls.
 */
function trackIntervalsUrl(page: Page): () => string | null {
  let seen: string | null = null;
  page.on("request", (req) => {
    const u = req.url();
    if (/\/api\/v1\/orgs\/[^/]+\/projects\/[^/]+\/intervals(\?|$)/.test(u)) seen = u;
  });
  return () => seen;
}

async function intervalsByName(page: Page, url: string, name: string) {
  const res = await page.request.get(url);
  expect(res.ok()).toBe(true);
  const body = await res.json();
  const rows: Array<{ name: string; status: string }> = Array.isArray(body)
    ? body
    : (body?.data ?? []);
  return rows.filter((r) => r.name === name);
}

test.describe.configure({ mode: "serial" });

test.describe("journey — completing a sprint rolls into the planned next one", () => {
  test("starts the sprint that already exists instead of creating a second one", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(180_000);
    const intervalsUrl = trackIntervalsUrl(page);
    await signInAs(EMAIL);

    await createProject(page);
    await planSprint(page, SPRINT_A, "2026-07-01", "2026-07-14");
    // Strictly later and PLANNED — this is what the roll-over must find.
    await planSprint(page, SPRINT_B, "2026-07-15", "2026-07-28");

    // Start Sprint 1. A SPRINT opens the planning dialog rather than activating
    // directly, so the sprint is started from inside it.
    const sprintARow = page
      .locator("li, div")
      .filter({ hasText: SPRINT_A })
      .first();
    await sprintARow.getByRole("button", { name: /^start$/i }).first().click();
    await expect(
      page.getByRole("heading", { name: new RegExp(`Start ${SPRINT_A}`) }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /^start sprint$/i }).click();

    // Complete Sprint 1: review step, then the carry-forward step.
    const completeBtn = page
      .locator("li, div")
      .filter({ hasText: SPRINT_A })
      .first()
      .getByRole("button", { name: /^complete$/i })
      .first();
    await expect(completeBtn).toBeVisible({ timeout: 20_000 });
    await completeBtn.click();

    await page.getByRole("button", { name: /^continue$/i }).click();
    await page.getByRole("button", { name: /complete interval/i }).click();

    // THE ASSERTION. Sprint 2 already exists, so the roll-over must offer to
    // start THAT one — named, and with no editable name/date fields, because
    // those fields feeding a CREATE is exactly how the second Sprint 2 was made.
    const rollover = page.getByRole("dialog");
    await expect(
      rollover.getByText(new RegExp(`Start ${SPRINT_B}\\?`)),
    ).toBeVisible({ timeout: 25_000 });
    await expect(rollover.getByText(/already planned/i)).toBeVisible();
    await expect(rollover.locator("#next-name")).toHaveCount(0);
    await expect(rollover.locator("#next-start")).toHaveCount(0);

    await rollover.getByRole("button", { name: /^start sprint$/i }).click();
    await expect(rollover).toBeHidden({ timeout: 25_000 });

    // Exactly ONE Sprint 2, and it is the one now running. Before the fix this
    // returned two rows — same name, same dates, different ids — with the
    // original still PLANNED.
    const url = intervalsUrl();
    expect(url, "the workspace should have fetched its intervals").not.toBeNull();
    const matches = await intervalsByName(page, url!, SPRINT_B);
    expect(matches).toHaveLength(1);
    expect(matches[0].status).toBe("ACTIVE");
  });
});
