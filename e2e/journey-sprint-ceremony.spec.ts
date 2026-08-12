import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — sprint ceremony boards.
 *
 * Drives the whole scrum-master path: plan a sprint, create the Sprint Review /
 * Retro board from the template gallery, point it at that sprint, start the
 * ceremony, and capture a retro note. Then checks that Sprint Planning — the
 * same component with `kind="PLANNING"` — renders its own tab set.
 *
 * The seeded "TEST" project (prisma/seed/test-fixtures.ts) has NO intervals and
 * no ceremony boards, and a ceremony board reports on a sprint, so the journey
 * has to create both. That is also what makes this worth running: it exercises
 * board creation seeding `defaultColumns` (a retro board whose columns never got
 * created opens with nowhere to put a note), the ceremony GET, the open
 * mutation, and the note round-trip.
 *
 * Mutating — runs in the CI e2e job (Postgres + test-fixtures seed). Alice is
 * ADMIN (org) + MANAGER (project), so she has SPRINT_CREATE and BOARD_CREATE.
 * Unique names per run so retries on the shared CI DB do not clash; the board
 * slug therefore tolerates the `-2`, `-3`, … suffix `uniqueBoardSlug` adds.
 *
 * No "What's new" handling needed: that modal skips its auto-open when
 * `navigator.webdriver` is true, precisely so its backdrop cannot swallow clicks
 * here.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const KEY = process.env.E2E_PROJECT_KEY ?? "test";

/** Plan a sprint from the Intervals page and return its name. */
async function planSprint(page: import("@playwright/test").Page, name: string) {
  await page.goto(`/${ORG}/projects/${KEY}/intervals`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("main", { timeout: 20_000 });

  await page.getByRole("button", { name: /new interval/i }).first().click();
  await expect(
    page.getByRole("heading", { name: /plan an interval/i }),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByLabel(/^Name$/).fill(name);
  await page.getByLabel(/start date/i).fill("2026-07-01");
  await page.getByLabel(/end date/i).fill("2026-07-14");
  await page.getByRole("button", { name: /create interval/i }).click();

  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
}

/**
 * Create a board from its built-in template card and land on it.
 *
 * The card is found by the h3 it CONTAINS, not by its own accessible name.
 * Two reasons, both learned the hard way:
 *
 *   - a card's accessible name is its category chips + title + description
 *     concatenated ("scrum agile Sprint Review / Retro What shipped, …"), so
 *     an anchored /^sprint planning/ never matches;
 *   - once a board of that name exists, the board tab strip above the gallery
 *     contributes `button "Tab actions for Sprint Review / Retro"`, which sorts
 *     EARLIER in the DOM. A name-regex + `.first()` picked that instead and
 *     opened a dropdown menu. This spec would have passed on a virgin database
 *     and failed on every run after — the worst possible shape for a flake.
 */
async function createBoardFromTemplate(
  page: import("@playwright/test").Page,
  templateTitle: string,
  slug: RegExp,
) {
  await page.goto(`/${ORG}/projects/${KEY}/boards/new`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("main", { timeout: 20_000 });

  const card = page.getByRole("button").filter({
    has: page.getByRole("heading", {
      level: 3,
      name: templateTitle,
      exact: true,
    }),
  });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();

  await expect(page).toHaveURL(slug, { timeout: 25_000 });
}

test.describe("journey — sprint ceremony boards", () => {
  test("run a retro: plan a sprint, create the board, start, capture a note", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(120_000);
    await signInAs(EMAIL);

    const stamp = Date.now().toString().slice(-6);
    const sprintName = `E2E Ceremony Sprint ${stamp}`;
    const note = `E2E retro note ${stamp}`;

    await planSprint(page, sprintName);
    await createBoardFromTemplate(
      page,
      "Sprint Review / Retro",
      /\/boards\/sprint-review-retro(-\d+)?$/i,
    );

    // The board opens on whichever sprint the project is in; this journey is
    // about the one it just planned, so pick it explicitly rather than assuming
    // a shared CI database contains only ours.
    const sprintPicker = page.locator("#ceremony-sprint");
    await expect(sprintPicker).toBeVisible({ timeout: 25_000 });
    await sprintPicker.selectOption({ label: sprintName });

    // Title is "<board> — <sprint>", so this asserts the board followed the pick.
    await expect(
      page.getByRole("heading", { name: new RegExp(sprintName) }),
    ).toBeVisible({ timeout: 20_000 });

    // A review's six sections. `Carrying forward` and `Next sprint` are the two
    // that only exist for kind="REVIEW" — see the planning test below.
    for (const label of [
      "Summary",
      "What shipped",
      "Carrying forward",
      "Retrospective",
      "Action items",
      "Next sprint",
    ]) {
      await expect(page.getByRole("tab", { name: label })).toBeVisible();
    }

    // Notes cannot be captured until the ceremony is open — the textarea is
    // rendered but its Add button stays disabled without a ceremony id.
    await page.getByRole("button", { name: /start ceremony/i }).click();
    await expect(page.getByRole("button", { name: /^close$/i })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole("tab", { name: "Retrospective" }).click();

    // Start / Stop / Continue come from the board's own BoardColumn rows, seeded
    // at creation from the type's defaultColumns. If that seeding regressed this
    // region would not exist, which is the point of asserting on it.
    const startColumn = page.getByRole("region", { name: "Start" });
    await expect(startColumn).toBeVisible({ timeout: 20_000 });

    await startColumn.getByLabel(`Add a note to Start`).fill(note);
    const add = startColumn.getByRole("button", { name: /^add$/i });
    await expect(add).toBeEnabled({ timeout: 10_000 });
    await add.click();

    // Assert on the note LIST, never `getByText` over the column.
    //
    // The column contains the textarea you just typed into as well as the notes,
    // so a bare text match is satisfied by the draft sitting in the input — it
    // passes whether or not anything was saved. The first draft of this spec did
    // exactly that and went green against a database with zero rows in it.
    const notes = startColumn.getByRole("listitem");
    await expect(notes.filter({ hasText: note })).toBeVisible({ timeout: 20_000 });

    // The list renders from the ceremony QUERY, so the note coming back means
    // the server accepted it. (Failing to invalidate was a real bug here: the
    // mutation took unprefixed key parts, and a prefixed key matched nothing.)
    // The textarea should also have been cleared on success.
    await expect(startColumn.getByLabel("Add a note to Start")).toHaveValue("");

    // Stronger still: prove it survives a fresh page. Selection is component
    // state, so the sprint has to be picked again.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(sprintPicker).toBeVisible({ timeout: 25_000 });
    await sprintPicker.selectOption({ label: sprintName });
    await page.getByRole("tab", { name: "Retrospective" }).click();
    await expect(
      page
        .getByRole("region", { name: "Start" })
        .getByRole("listitem")
        .filter({ hasText: note }),
    ).toBeVisible({ timeout: 25_000 });
  });

  test("sprint planning renders the planning sections, not the review's", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(90_000);
    await signInAs(EMAIL);

    await createBoardFromTemplate(
      page,
      "Sprint Planning",
      /\/boards\/sprint-planning(-\d+)?$/i,
    );

    await expect(page.locator("#ceremony-sprint")).toBeVisible({
      timeout: 25_000,
    });

    for (const label of ["Summary", "Capacity", "Notes", "Action items"]) {
      await expect(page.getByRole("tab", { name: label })).toBeVisible();
    }

    // Planning is not a review: asserting the absence alone would pass on a
    // board that rendered no tabs at all, so it sits after the four above.
    await expect(page.getByRole("tab", { name: "What shipped" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Next sprint" })).toHaveCount(0);

    // Capacity is the planning-only panel, and it is a separate fetch.
    await page.getByRole("tab", { name: "Capacity" }).click();
    await expect(page.getByText(/team capacity/i).first()).toBeVisible({
      timeout: 25_000,
    });
  });
});
