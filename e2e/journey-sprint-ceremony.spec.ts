import { test, expect } from "./fixtures/auth";
// The auth fixture re-exports only `test` and `expect`; the Page type comes from
// Playwright itself. Playwright transpiles specs without typechecking, so this
// only surfaces under `tsc`.
import type { Page } from "@playwright/test";

/**
 * E2E journey — sprint ceremony boards, every CRUD operation.
 *
 * The first version of this spec drove a happy path only: create a board, start
 * a ceremony, add one note. Everything it touched worked, so it reported the
 * boards as healthy while five user-visible defects sat in the surfaces it never
 * exercised — a promote link that 404'd, an Owner picker of blank options, an
 * Owner column that printed "—" for owned actions, a due date rendered a day
 * early, and a "next sprint" that invented a sprint the team had already
 * planned. Each assertion below that names a bug is there because of one.
 *
 * Serial by design: the sprints and the boards are created once by the first
 * test and reused, because creating them per-test triples an already slow run.
 * `workers: 1` in playwright.config makes that safe.
 *
 * Mutating — runs in the CI e2e job (Postgres + test-fixtures seed). Alice is
 * ADMIN (org) + MANAGER (project). Unique names per run so retries on the shared
 * CI DB do not clash; board slugs tolerate the `-2`, `-3`, … suffix
 * `uniqueBoardSlug` adds.
 *
 * No "What's new" handling needed: that modal skips its auto-open when
 * `navigator.webdriver` is true, precisely so its backdrop cannot swallow clicks.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const KEY = process.env.E2E_PROJECT_KEY ?? "test";

const STAMP = Date.now().toString().slice(-6);
/** The sprint the ceremony reports on. */
const SPRINT = `E2E Ceremony Sprint ${STAMP}`;
/** A LATER planned sprint, so "Next sprint" has a real one to find. */
const NEXT_SPRINT = `E2E Ceremony Next ${STAMP}`;

let reviewUrl = "";
let planningUrl = "";

async function planSprint(page: Page, name: string, start: string, end: string) {
  await page.goto(`/${ORG}/projects/${KEY}/intervals`, {
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
 * Create a board from its built-in template card.
 *
 * Located by the h3 the card CONTAINS, not by the card's own accessible name.
 * That name is category chips + title + description concatenated ("scrum agile
 * Sprint Review / Retro What shipped, …"), so an anchored regex never matches —
 * and worse, once a board of that name exists the board tab strip contributes
 * `button "Tab actions for <name>"` EARLIER in the DOM, which a name regex plus
 * `.first()` picked instead, opening a dropdown. That version passed on a virgin
 * database and failed on every run after.
 */
async function createBoardFromTemplate(
  page: Page,
  templateTitle: string,
  slug: RegExp,
) {
  await page.goto(`/${ORG}/projects/${KEY}/boards/new`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("main", { timeout: 20_000 });

  const card = page.getByRole("button").filter({
    has: page.getByRole("heading", { level: 3, name: templateTitle, exact: true }),
  });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await expect(page).toHaveURL(slug, { timeout: 25_000 });
}

/** Point the board at our sprint. Selection is component state, so every fresh load needs it. */
async function selectSprint(page: Page, name = SPRINT) {
  const picker = page.locator("#ceremony-sprint");
  await expect(picker).toBeVisible({ timeout: 25_000 });
  await picker.selectOption({ label: name });
  await expect(
    page.getByRole("heading", { name: new RegExp(name) }),
  ).toBeVisible({ timeout: 20_000 });
}

const tab = (page: Page, name: string) =>
  page.getByRole("tab", { name, exact: true });

test.describe.configure({ mode: "serial" });

test.describe("journey — sprint ceremony boards", () => {
  test("set up: two sprints and both ceremony boards", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(150_000);
    await signInAs(EMAIL);

    await planSprint(page, SPRINT, "2026-07-01", "2026-07-14");
    // Strictly later, and PLANNED — this is what "Next sprint" must find.
    await planSprint(page, NEXT_SPRINT, "2026-07-15", "2026-07-28");

    await createBoardFromTemplate(
      page,
      "Sprint Review / Retro",
      /\/boards\/sprint-review-retro(-\d+)?$/i,
    );
    reviewUrl = page.url();

    await createBoardFromTemplate(
      page,
      "Sprint Planning",
      /\/boards\/sprint-planning(-\d+)?$/i,
    );
    planningUrl = page.url();

    expect(reviewUrl).not.toBe("");
    expect(planningUrl).not.toBe("");
  });

  test("review board shows the six sections and excludes Program Increments", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(90_000);
    await signInAs(EMAIL);
    await page.goto(reviewUrl, { waitUntil: "domcontentloaded" });
    await selectSprint(page);

    for (const label of [
      "Summary",
      "What shipped",
      "Carrying forward",
      "Retrospective",
      "Action items",
      "Next sprint",
    ]) {
      await expect(tab(page, label)).toBeVisible();
    }

    // A ceremony reports on an ITERATION. A PI holds no work items, so opening
    // on one showed 0 points / 0 of 0 items — a claim about the team that the
    // data does not support.
    const options = await page.locator("#ceremony-sprint option").allTextContents();
    expect(options.some((o) => /^PI-/i.test(o.trim()))).toBe(false);
  });

  test("retro notes: add to every column, delete one, survive a reload", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(120_000);
    await signInAs(EMAIL);
    await page.goto(reviewUrl, { waitUntil: "domcontentloaded" });
    await selectSprint(page);

    // Notes need an open ceremony; the Add button stays disabled without one.
    await page.getByRole("button", { name: /start ceremony/i }).click();
    await expect(page.getByRole("button", { name: /^close$/i })).toBeVisible({
      timeout: 20_000,
    });

    await tab(page, "Retrospective").click();

    // Start / Stop / Continue are BoardColumn rows seeded at creation from the
    // type's defaultColumns. Without that seeding there is nowhere to put a note.
    for (const column of ["Start", "Stop", "Continue"]) {
      const region = page.getByRole("region", { name: column });
      await expect(region).toBeVisible({ timeout: 20_000 });

      await region.getByLabel(`Add a note to ${column}`).fill(`note in ${column}`);
      const add = region.getByRole("button", { name: /^add$/i });
      await expect(add).toBeEnabled({ timeout: 10_000 });
      await add.click();

      // Assert on the LIST, never `getByText` over the region: the column holds
      // the textarea you just typed into as well as the notes, so a bare text
      // match is satisfied by the draft and goes green against an empty table.
      await expect(
        region.getByRole("listitem").filter({ hasText: `note in ${column}` }),
      ).toBeVisible({ timeout: 20_000 });
      // Cleared on success is the other half of "the server took it".
      await expect(region.getByLabel(`Add a note to ${column}`)).toHaveValue("");
    }

    // Delete removes exactly the one note, leaving the siblings alone.
    const stop = page.getByRole("region", { name: "Stop" });
    await stop.getByRole("button", { name: "Delete note" }).first().click();
    await expect(
      stop.getByRole("listitem").filter({ hasText: "note in Stop" }),
    ).toHaveCount(0, { timeout: 20_000 });
    await expect(
      page.getByRole("region", { name: "Start" })
        .getByRole("listitem")
        .filter({ hasText: "note in Start" }),
    ).toBeVisible();

    // Persistence, not just a refetch.
    await page.reload({ waitUntil: "domcontentloaded" });
    await selectSprint(page);
    await tab(page, "Retrospective").click();
    await expect(
      page.getByRole("region", { name: "Start" })
        .getByRole("listitem")
        .filter({ hasText: "note in Start" }),
    ).toBeVisible({ timeout: 25_000 });
  });

  test("action items: owner and due date render, promote links somewhere real, delete", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(120_000);
    await signInAs(EMAIL);
    await page.goto(reviewUrl, { waitUntil: "domcontentloaded" });
    await selectSprint(page);
    await tab(page, "Action items").click();

    // BUG GUARD: the picker listed one blank option per member, because the
    // members endpoint nests the name on `user` and the component read it flat.
    const ownerOptions = await page.locator("#action-owner option").allTextContents();
    expect(ownerOptions.every((o) => o.trim().length > 0)).toBe(true);
    expect(ownerOptions.length).toBeGreaterThan(1);

    await page.locator("#action-text").fill("Automate the release checklist");
    await page.locator("#action-owner").selectOption({ index: 1 });
    await page.locator("#action-due").fill("2026-09-15");
    await page.getByRole("button", { name: /add action/i }).click();

    const row = page.getByRole("row").filter({ hasText: "Automate the release checklist" });
    await expect(row).toBeVisible({ timeout: 20_000 });

    // BUG GUARD: the Owner column printed "—" for owned actions.
    const ownerName = (ownerOptions[1] ?? "").trim();
    await expect(row.getByRole("cell", { name: ownerName, exact: true })).toBeVisible();

    // BUG GUARD: a due date entered as the 15th rendered as the 14th for any
    // reader behind UTC — it is a calendar day stored at midnight UTC.
    await expect(row.getByText("Sep 15, 2026")).toBeVisible();

    // Promote is what makes a retro consequential.
    await row.getByRole("button", { name: /promote/i }).click();
    const tracked = row.getByRole("link", { name: /tracked/i });
    await expect(tracked).toBeVisible({ timeout: 25_000 });

    // BUG GUARD: it pointed at /projects/<key>/items/<id>, which is not a route
    // in this app — the link 404'd. Assert the shape AND that it resolves.
    const href = await tracked.getAttribute("href");
    expect(href).toMatch(/\/issues\?item=[0-9a-f-]{36}$/i);
    const resolved = await page.request.get(href!);
    expect(resolved.status()).toBe(200);

    // Delete removes the row.
    await page.locator("#action-text").fill("Throwaway action");
    await page.getByRole("button", { name: /add action/i }).click();
    const throwaway = page.getByRole("row").filter({ hasText: "Throwaway action" });
    await expect(throwaway).toBeVisible({ timeout: 20_000 });
    await throwaway.getByRole("button", { name: /^delete action/i }).click();
    await expect(throwaway).toHaveCount(0, { timeout: 20_000 });
  });

  test("next sprint names the one already planned, not an invented one", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(90_000);
    await signInAs(EMAIL);
    await page.goto(reviewUrl, { waitUntil: "domcontentloaded" });
    await selectSprint(page);
    await tab(page, "Next sprint").click();

    // BUG GUARD: this tab rendered a COMPUTED suggestion unconditionally, so a
    // team who had planned the next sprint saw a fabricated one — invented name,
    // invented dates — stated in the same voice as fact.
    //
    // Scoped to the panel's <dd>s. A bare `getByText(NEXT_SPRINT)` matches the
    // sprint PICKER's hidden <option> for the same sprint first, which is both a
    // false negative here and would be a false positive if the panel were empty.
    const panel = page.getByRole("definition");
    await expect(panel.filter({ hasText: NEXT_SPRINT })).toBeVisible({
      timeout: 25_000,
    });
    await expect(panel.filter({ hasText: "Already planned" })).toBeVisible();
  });

  test("closing makes the ceremony read-only; reopening restores it", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(120_000);
    await signInAs(EMAIL);
    await page.goto(reviewUrl, { waitUntil: "domcontentloaded" });
    await selectSprint(page);

    await page.getByRole("button", { name: /^close$/i }).click();
    await expect(page.getByRole("button", { name: /reopen/i })).toBeVisible({
      timeout: 20_000,
    });

    // Read-only: no compose form, no destructive controls — but the record of
    // what was said stays readable, which is the point of closing rather than
    // deleting.
    await tab(page, "Retrospective").click();
    const start = page.getByRole("region", { name: "Start" });
    await expect(
      start.getByRole("listitem").filter({ hasText: "note in Start" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(start.getByLabel("Add a note to Start")).toHaveCount(0);
    await expect(start.getByRole("button", { name: "Delete note" })).toHaveCount(0);

    await tab(page, "Action items").click();
    await expect(page.locator("#action-text")).toHaveCount(0);

    await page.getByRole("button", { name: /reopen/i }).click();
    await expect(page.getByRole("button", { name: /^close$/i })).toBeVisible({
      timeout: 20_000,
    });
    await tab(page, "Retrospective").click();
    await expect(
      page.getByRole("region", { name: "Start" }).getByLabel("Add a note to Start"),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("present mode actually enlarges the figures, not just the title", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(90_000);
    await signInAs(EMAIL);
    await page.goto(reviewUrl, { waitUntil: "domcontentloaded" });
    await selectSprint(page);

    // Measure RENDERED height, never computed font-size: present mode scales
    // with `zoom`, which does not change computed font-size at all. A test
    // reading getComputedStyle would report "30px" in both states and pass over
    // a mode that scaled nothing.
    const figure = page.getByText("Story points completed").locator("..");
    const heightOf = async () =>
      (await figure.boundingBox())?.height ?? 0;

    const before = await heightOf();
    expect(before).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Present" }).click();
    await expect(
      page.getByRole("button", { name: "Exit presentation" }),
    ).toBeVisible({ timeout: 10_000 });

    // BUG GUARD: this used to set a container font-size and expect rem-based
    // Tailwind sizes to follow. They do not — rem resolves against <html> — so
    // only the <h2> grew and the headline figures a room is meant to read stayed
    // at 30px. Anything at or below 1.2x means the scaling regressed.
    const after = await heightOf();
    expect(after / before).toBeGreaterThan(1.2);

    // Full-bleed, and it must not push the page sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    );

    // Exiting restores the in-page board rather than stranding the facilitator.
    await page.getByRole("button", { name: "Exit presentation" }).click();
    await expect(page.getByRole("button", { name: "Present" })).toBeVisible({
      timeout: 10_000,
    });
    expect(await heightOf()).toBeCloseTo(before, 0);
  });

  test("planning board: its own sections, and capacity that does not oversell", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(90_000);
    await signInAs(EMAIL);
    await page.goto(planningUrl, { waitUntil: "domcontentloaded" });
    await selectSprint(page);

    for (const label of ["Summary", "Capacity", "Notes", "Action items"]) {
      await expect(tab(page, label)).toBeVisible();
    }
    // Planning is not a review. Checked AFTER the four above, so an absence
    // assertion cannot pass on a board that rendered no tabs at all.
    await expect(tab(page, "What shipped")).toHaveCount(0);
    await expect(tab(page, "Next sprint")).toHaveCount(0);

    await tab(page, "Capacity").click();
    await expect(page.getByText(/team capacity/i).first()).toBeVisible({
      timeout: 25_000,
    });

    // BUG GUARD: with no per-member capacity recorded, headroom computed to 0
    // and the panel announced "Within capacity" — a reassurance drawn from no
    // data at all, next to copy claiming headroom "reads as negative".
    await expect(page.getByText("Within capacity")).toHaveCount(0);
    await expect(page.getByText(/unknown until capacity is set/i)).toBeVisible();

    // The planning board's own columns, seeded from its type's defaultColumns.
    await tab(page, "Notes").click();
    for (const column of ["Risks", "Questions", "Decisions"]) {
      await expect(page.getByRole("region", { name: column })).toBeVisible({
        timeout: 20_000,
      });
    }
  });
});
