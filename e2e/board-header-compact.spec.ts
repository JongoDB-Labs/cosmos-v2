import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures/auth";
import { resetQueryLanguage, setQueryLanguage } from "./fixtures/work-items-query";

/**
 * The board header takes fewer rows, never more, and every control is still in it.
 *
 * The board's scope line, swimlanes and actions moved into the query bar's own
 * row, and a sprint's name, dates and summary into the row of sprint pills.
 * Unit tests pin which row each control is rendered in; only a browser can say
 * how tall the header comes out and whether each control is still on screen,
 * so this spec measures both, at the sizes where the layout was at risk.
 *
 * Height budgets are the header's height on main before this change, measured
 * on this spec's own boards and sizes (`next dev`, the seeded gallery): first
 * band's top to the query band's bottom. The header may come out shorter than
 * main, never taller. `SLACK` covers sub-pixel rounding only; one wrapped line
 * costs 28px or more. A wrapping regression found in review (Timeline at 1024:
 * 145 -> 171px), deleting the board's controls from the bar, and a search that
 * moves the board (Clear not holding its place) each fail here.
 *
 * Runs against the seeded board gallery (`prisma/seed/test-fixtures.ts`). It
 * switches the query language on for the org (the bar measured here only
 * exists with it on) and off again afterwards, as `journey-board-cql.spec.ts`
 * does. Five page loads in all: each is about 10s under `next dev` in CI.
 */
const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const GALLERY = process.env.E2E_GALLERY_PROJECT_KEY ?? "GALLERY";
const EMAIL = "alice@test.local";
const SLACK = 6;

type Mode = "Filters" | "CQL";

/** The query bar's band, and the sprint pills' band where the board has one. */
function bands(page: Page) {
  const query = page.getByRole("group", { name: "How to filter" }).locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
  const pills = page.getByRole("button", { name: "Manage", exact: true }).locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
  return { query, pills };
}

async function headerHeight(page: Page) {
  const { query, pills } = bands(page);
  const q = (await query.boundingBox())!;
  const p = (await pills.count()) ? await pills.boundingBox() : null;
  return Math.round((q.y + q.height - (p ? p.y : q.y)) * 10) / 10;
}

/**
 * What shows once a board's data is in. The header can change until then: a
 * sprint board's scope line appears only when its sprints arrive, and on CI's
 * slow server that came about 8s after the bar did. The row then took a second
 * line, after the header had already been measured (reproduced locally by
 * holding the sprints back 8s: the band's bottom went from 199 to 231px).
 */
const READY: Record<string, (p: Page) => Locator[]> = {
  scrum: (p) => [p.getByText(/^This board shows/), p.getByText("Gallery item in progress").first()],
  timeline: (p) => [p.getByText("Gallery item in backlog").first()],
  table: (p) => [p.getByText("Gallery item in backlog").first()],
};

async function openBoard(page: Page, slug: keyof typeof READY, size: { width: number; height: number }) {
  // A fresh load at each size, not a resize of a loaded page: in headless
  // Chromium, after setViewportSize elementFromPoint answered <html> for every
  // point on the page (measured), which made every control read as covered.
  // And a phone's CQL box is chosen at load, from the screen width.
  await page.setViewportSize(size);
  await page.goto(`/${ORG}/projects/${GALLERY}/boards/${slug}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("group", { name: "How to filter" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 30_000 });
  for (const l of READY[slug](page)) await expect(l).toBeVisible({ timeout: 30_000 });
}

/** Switch mode (a click on the loaded page, as a person does it) and let the row settle. */
async function useMode(page: Page, mode: Mode) {
  const toggle = page.getByRole("group", { name: "How to filter" }).getByRole("button", { name: mode });
  // The builder remembers the mode across loads, so it may already be on.
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  if (mode === "CQL") await expect(page.getByRole("textbox", { name: "Query" })).toBeVisible({ timeout: 30_000 });
  else await expect(page.getByRole("textbox", { name: "Search work items" })).toBeVisible();
  // Pages cross-fade with a View Transition (components/ui/page-transition.tsx),
  // and while one runs every hit test lands on <html>, the transition's layer.
  // Not `getAnimations()`: finished animations linger in that list.
  await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"), null, { timeout: 15_000 });
  await settle(page);
}

/** Two equal readings of the header's height, 150ms apart. */
async function settle(page: Page) {
  await expect
    .poll(async () => {
      const a = await headerHeight(page);
      await page.waitForTimeout(150);
      return a === (await headerHeight(page));
    })
    .toBe(true);
}

/**
 * Each named control is on screen, inside the header's bands, and is what a
 * click at its centre reaches. Deleting a board's controls from the bar fails
 * here: they are named, not counted.
 */
async function expectControls(page: Page, at: string, controls: [string, Locator][]) {
  const { query, pills } = bands(page);
  const box = (b: { x: number; y: number; width: number; height: number }) =>
    `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`;
  for (const [name, l] of controls) {
    const c = l.first();
    await expect(c, `${at}: ${name} is missing`).toBeVisible();
    // The bands are read with the control, not once up front: a control that
    // waited to appear above may have moved the others.
    const boxes = [(await query.boundingBox())!];
    if (await pills.count()) boxes.push((await pills.boundingBox())!);
    const b = (await c.boundingBox())!;
    const inside = boxes.some((k) => b.x >= k.x - 1 && b.y >= k.y - 1 && b.x + b.width <= k.x + k.width + 1 && b.y + b.height <= k.y + k.height + 1);
    expect(inside, `${at}: ${name} (${box(b)}) is outside the header (${boxes.map(box).join("; ")})`).toBe(true);
    // A disabled control takes no pointer events, so a hit test passes through
    // it. Retried for a few seconds: a View Transition that starts after the
    // wait in useMode (a Suspense reveal) puts its layer over everything for
    // ~250ms. A real overlap stays, and fails naming the control.
    await expect
      .poll(
        () =>
          c.evaluate((el) => {
            if ((el as HTMLButtonElement).disabled || getComputedStyle(el).pointerEvents === "none") return true;
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!hit && (hit === el || el.contains(hit));
          }),
        { message: `${at}: ${name} is covered`, timeout: 5_000 },
      )
      .toBe(true);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${at}: the page scrolls sideways`).toBeLessThanOrEqual(0);
}

async function expectBudget(page: Page, at: string, budget: number) {
  const h = await headerHeight(page);
  expect(h, `${at}: the header is ${h}px, taller than main's ${budget}px`).toBeLessThanOrEqual(budget + SLACK);
}

/** What the query bar always draws, per mode. */
function queryBar(page: Page, mode: Mode): [string, Locator][] {
  return mode === "Filters"
    ? [
        ["Search", page.getByRole("textbox", { name: "Search work items" })],
        ["Add filter", page.getByRole("combobox", { name: "Add filter" })],
      ]
    : [
        ["Query", page.getByRole("textbox", { name: "Query" })],
        ["Run query", page.getByRole("button", { name: /Run query/ })],
        ["Syntax help", page.getByRole("button", { name: "Syntax help" })],
        ["Add filter", page.getByRole("combobox", { name: "Add filter" })],
      ];
}

const newWorkItem = (p: Page): [string, Locator] => ["New work item", p.getByRole("button", { name: /New work item/ })];

/** A sprint board's own controls: the pill row's, and the ones the bar carries for it. */
const scrumControls = (p: Page): [string, Locator][] => [
  ["Manage", p.getByRole("button", { name: "Manage", exact: true })],
  ["All items", p.getByRole("button", { name: "All items" })],
  ["Sprint 1 pill", p.getByRole("button", { name: "Sprint 1", exact: true })],
  ["sprint name", p.getByRole("heading", { name: "Sprint 1" })],
  ["scope", p.getByText(/^This board shows/)],
  ["Swimlanes", p.getByRole("combobox", { name: "Group into swimlanes" })],
  ["Select", p.getByRole("button", { name: "Select", exact: true })],
  newWorkItem(p),
];

/** Timeline's toolbar, the longest a board passes to the bar. */
const timelineControls = (p: Page): [string, Locator][] => [
  ["Critical path", p.getByRole("button", { name: "Critical path", exact: true })],
  ["Hide done", p.getByRole("button", { name: "Hide done" })],
  ["Zoom in", p.getByRole("button", { name: "Zoom in" })],
  ["Enter fullscreen", p.getByRole("button", { name: "Enter fullscreen" })],
  ["Undo", p.getByRole("button", { name: "Undo" })],
  ["Redo", p.getByRole("button", { name: "Redo" })],
  newWorkItem(p),
];


const PHONE = { width: 390, height: 844 };

/** The header's height at each width, read after it settles. Heights only: see openBoard. */
async function heightsAt(page: Page, widths: readonly number[]) {
  const out: string[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    await settle(page);
    out.push(`${width}px: ${await headerHeight(page)}`);
  }
  return out;
}

/**
 * Applying a filter must not move the board, nor clearing it. Clear holds its
 * place in the row while there is nothing to clear. When it appeared on the
 * first search instead, it pushed the row's last control onto a line of its
 * own and the columns moved down 32px.
 *
 * That only happens where the row is one Clear short of full: a window about
 * Clear's width, which moves with the board and its controls (on the sprint
 * board, 1456-1528px measured with Clear not held). So the header is read
 * across a sweep of widths, empty and then with a search applied, and must
 * match at every one. It resizes the page, so it runs last on its load.
 */
async function expectNoJump(page: Page, at: string, widths: readonly number[]) {
  const search = page.getByRole("textbox", { name: "Search work items" });
  const before = await heightsAt(page, widths);
  await search.fill("review");
  await search.press("Enter");
  await expect(page.getByText("Gallery item in progress")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("Gallery item in review").first()).toBeVisible();
  const clear = page.getByRole("button", { name: "Clear", exact: true });
  await expect(clear).toBeVisible();
  expect(await heightsAt(page, widths), `${at}: applying a search moved the board`).toEqual(before);
  await clear.click();
  await expect(page.getByText("Gallery item in progress").first()).toBeVisible({ timeout: 15_000 });
  await expect(clear).toHaveCount(0);
  await settle(page);
  expect(await heightsAt(page, widths.slice(-1)), `${at}: clearing the search moved the board`).toEqual(before.slice(-1));
}

/** 1280, then 1392-1584px in 16px steps: the sprint board's window with room either side. */
const SWEEP = [1280, ...Array.from({ length: 13 }, (_, i) => 1392 + 16 * i)] as const;

test.describe("Board header — fewer rows", () => {
  test.afterAll(async ({ browser }) => {
    await resetQueryLanguage(browser);
  });

  test.beforeEach(async ({ page, signInAs }) => {
    await signInAs(EMAIL);
    await setQueryLanguage(page.request, true);
  });

  test("scrum at 1280: within main's height in both modes, every moved control works, and a search never moves the board", async ({ page }) => {
    test.setTimeout(150_000);
    await openBoard(page, "scrum", { width: 1280, height: 800 });
    const budget = { Filters: 150, CQL: 187.6 };

    await useMode(page, "Filters");
    await expectBudget(page, "scrum@1280 Filters", budget.Filters);
    await expectControls(page, "scrum@1280 Filters", [...queryBar(page, "Filters"), ...scrumControls(page)]);

    // Swimlanes: grouping by priority draws a lane, each a labelled strip of
    // columns (kanban-board.tsx). None exists with swimlanes off, when the one
    // strip is "Board columns".
    const swimlanes = page.getByRole("combobox", { name: "Group into swimlanes" });
    const lanes = page.locator('[aria-label$=" columns"]:not([aria-label="Board columns"])');
    await expect(page.locator('[aria-label="Board columns"]')).toHaveCount(1);
    await expect(lanes).toHaveCount(0);
    await swimlanes.click();
    await page.getByRole("option", { name: "Priority" }).click();
    await expect(lanes.first()).toBeVisible({ timeout: 15_000 });
    await swimlanes.click();
    await page.getByRole("option", { name: "None" }).click();
    await expect(lanes).toHaveCount(0);

    // Scope: All items drops the sprint scope; the pill brings it back.
    const scope = page.getByText(/^This board shows/);
    await page.getByRole("button", { name: "All items" }).click();
    await expect(page.getByText(/showing the full board/)).toBeVisible();
    await expect(scope).toHaveCount(0);
    await page.getByRole("button", { name: "Sprint 1", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sprint 1" })).toBeVisible();
    // Shown whole, not truncated with the rest in a tooltip.
    await expect(scope).toContainText('sprint = "Sprint 1"');
    expect(await scope.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "the scope is cut off").toBe(true);

    // Manage still opens the sprint drawer.
    await page.getByRole("button", { name: "Manage", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Select still enters select mode, and Done leaves it.
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible();

    await useMode(page, "CQL");
    await expectBudget(page, "scrum@1280 CQL", budget.CQL);
    await expectControls(page, "scrum@1280 CQL", [...queryBar(page, "CQL"), ...scrumControls(page)]);

    // Last, because it resizes the page.
    await useMode(page, "Filters");
    await expectNoJump(page, "scrum Filters", SWEEP);
  });

  test("scrum on a phone: within main's height, and the CQL box gets a line of its own", async ({ page }) => {
    test.setTimeout(90_000);
    await openBoard(page, "scrum", PHONE);
    await useMode(page, "Filters");
    await expectBudget(page, "scrum@390 Filters", 258);
    await expectControls(page, "scrum@390 Filters", [...queryBar(page, "Filters"), ...scrumControls(page)]);

    await useMode(page, "CQL");
    await expectBudget(page, "scrum@390 CQL", 712);
    await expectControls(page, "scrum@390 CQL", [...queryBar(page, "CQL"), ...scrumControls(page)]);
    // It was about 45px wide: Run query and Format took the line first, and
    // the placeholder wrapped a few letters per line.
    const box = (await page.getByRole("textbox", { name: "Query" }).boundingBox())!;
    expect(box.width).toBeGreaterThan(200);
    const run = (await page.getByRole("button", { name: /Run query/ }).boundingBox())!;
    expect(run.y, "Run query is beside the query box, not under it").toBeGreaterThanOrEqual(box.y + box.height - 1);
  });

  for (const [size, budget] of [
    [{ width: 1024, height: 768 }, { Filters: 145, CQL: 202.2 }],
    [PHONE, { Filters: 243, CQL: 697 }],
  ] as const) {
    test(`timeline at ${size.width}: its long toolbar wraps within main's height`, async ({ page }) => {
      test.setTimeout(90_000);
      await openBoard(page, "timeline", size);
      for (const mode of ["Filters", "CQL"] as const) {
        const at = `timeline@${size.width} ${mode}`;
        await useMode(page, mode);
        await expectBudget(page, at, budget[mode]);
        await expectControls(page, at, [...queryBar(page, mode), ...timelineControls(page)]);
      }
    });
  }

  test("table on a phone: within main's height, with its own toolbar", async ({ page }) => {
    test.setTimeout(90_000);
    await openBoard(page, "table", PHONE);
    const table = (p: Page): [string, Locator][] => [
      ["Group by", p.getByRole("combobox", { name: "Group by" })],
      ["Comfortable rows", p.getByRole("button", { name: "Comfortable rows" })],
      ["Compact rows", p.getByRole("button", { name: "Compact rows" })],
      newWorkItem(p),
    ];
    for (const [mode, budget] of [["Filters", 149], ["CQL", 603]] as const) {
      await useMode(page, mode);
      await expectBudget(page, `table@390 ${mode}`, budget);
      await expectControls(page, `table@390 ${mode}`, [...queryBar(page, mode), ...table(page)]);
    }
  });
});
