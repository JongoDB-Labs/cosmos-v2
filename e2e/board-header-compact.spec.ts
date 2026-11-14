import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures/auth";
import { resetQueryLanguage, setQueryLanguage } from "./fixtures/work-items-query";
import MAIN_HEIGHTS from "./board-header-compact.main.json";

/**
 * The board header takes fewer rows, never more, and every control is still in it.
 *
 * The board's scope line, swimlanes and actions moved into the query bar's own
 * row, and a sprint's name, dates and summary into the row of sprint pills.
 * Unit tests pin which row each control is rendered in; only a browser can say
 * how tall the header comes out and whether each control is still on screen.
 * Height is the first band's top to the query band's bottom.
 *
 * Height is checked two ways, both against main before this change:
 *
 *   - Within every load, a sweep from 360 to 1920px in 24px steps, plus six
 *     widths at the 640px edge, in both modes: at no width taller than main,
 *     except where EXCEPTIONS names the board, mode and widths, and then by
 *     no more than it allows. Main's heights are in
 *     `board-header-compact.main.json`, measured by this same sweep on main
 *     (`next dev`, the seeded gallery), once in Linux Chromium (CI's) and
 *     once on a Mac. The two set text a pixel or two apart, and that moves a
 *     wrap at some widths: main's heights differ between them at about one
 *     point in ten, and this layout in Linux came out taller than the Mac's
 *     main at 5 of the 66-step sweep's 396 points. A review found the row a
 *     line taller than main on most boards between 768 and 810px, where no
 *     fixed size here looked; a later one found the 628-639px band in
 *     EXCEPTIONS, between two 24px steps.
 *   - At each load's own size, a budget: main's height there, or this
 *     layout's own plus SLACK where that is less, so giving back what the
 *     change saved fails too (the scope on a line of its own at 1280: 126 ->
 *     146px).
 *
 * And on the sprint board, the same height at every width of the sweep while a
 * query-like phrase is typed, with a search applied, and after it is cleared:
 * Clear and "Run as a query" take no room in the row.
 *
 * Runs against the seeded board gallery (`prisma/seed/test-fixtures.ts`). It
 * switches the query language on for the org (the bar measured here only
 * exists with it on) and off again afterwards, as `journey-board-cql.spec.ts`
 * does. Five page loads and 13 sweeps of 72 widths: 80-90s in all locally,
 * on a Mac or in Linux Chromium.
 */
const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const GALLERY = process.env.E2E_GALLERY_PROJECT_KEY ?? "GALLERY";
const EMAIL = "alice@test.local";
/** How far over its own measured height a load may come out. One wrapped line costs 16px or more. */
const SLACK = 6;
/** Sub-pixel rounding between machines, for the sweep's comparisons. */
const ROUNDING = 0.5;

type Mode = "Filters" | "CQL";

/** The query bar's band, and the sprint pills' band where the board has one. */
function bands(page: Page) {
  const query = page.getByRole("group", { name: "How to filter" }).locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
  const pills = page.getByRole("button", { name: "Manage", exact: true }).locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
  return { query, pills };
}

/**
 * The header's height once it stops changing: no transition running, then
 * three frames alike. Buttons change size over 150ms at the 768px breakpoint,
 * and the CQL editor re-wraps as they do (measured at 768: it grew for 185ms,
 * and a settle of two equal readings returned 455 of its 651px). A loading
 * placeholder (the editor's, pulsing) is not settled either. NaN when it never
 * settles, so the comparison that reads it fails.
 */
function headerHeight(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const read = () => {
      const query = document.querySelector('[role="group"][aria-label="How to filter"]')!.closest(".border-b")!;
      const manage = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Manage");
      const top = (manage?.closest(".border-b") ?? query).getBoundingClientRect().top;
      return { h: Math.round((query.getBoundingClientRect().bottom - top) * 10) / 10, loading: !!query.querySelector(".animate-pulse") };
    };
    const moving = () =>
      document.getAnimations().some((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime));
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const t0 = performance.now();
    let last = read().h;
    for (let same = 0; same < 3; ) {
      if (performance.now() - t0 > 15_000) return NaN;
      await frame();
      const now = read();
      same = now.h === last && !now.loading && !moving() ? same + 1 : 0;
      last = now.h;
    }
    return last;
  });
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
  await headerHeight(page);
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

/**
 * Main's height at a load's size, and this layout's own there (measured, `next
 * dev`, the seeded gallery). The budget is the lesser of main and own + SLACK.
 * Linux Chromium and a Mac measured the same at every size here, but for main's
 * phone CQL box: Linux sets it 120px shorter (592, 577 and 483px against 712,
 * 697 and 603). Own + SLACK is under both.
 */
type Budget = { main: number; own: number };

async function expectBudget(page: Page, at: string, { main, own }: Budget) {
  const budget = Math.min(main, own + SLACK);
  const h = await headerHeight(page);
  expect(h, `${at}: the header is ${h}px, over its budget of ${budget}px (main ${main}, this layout ${own})`).toBeLessThanOrEqual(budget);
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

type Board = keyof typeof READY;
type Heights = Record<string, number>;
type Main = Record<Board, Record<Mode, Heights>>;
/** Main's heights in CI's Linux Chromium, and on a Mac (see the top of the file). */
const MAIN: { linux: Main; darwin: Main } = MAIN_HEIGHTS;

/** Main's heights as measured on the OS this browser runs on: a Mac's, or else Linux's. */
async function mainHere(page: Page): Promise<Main> {
  // Not process.platform: the browser can run elsewhere (a Linux browser
  // driven from a Mac). Not the user agent: the Desktop Chrome profile says
  // Windows.
  const mac = await page.evaluate(() => navigator.platform.startsWith("Mac"));
  return MAIN[mac ? "darwin" : "linux"];
}

/**
 * Either side of 640px, where a CQL box goes from beside its buttons to a line
 * of its own (`NARROW` in query-builder.tsx). The 24px steps pass from 624 to
 * 648 and never saw what EXCEPTIONS allows.
 */
const EDGE = [627, 628, 633, 639, 640, 641];

/** The sweep: 360-1920px in 24px steps, and the edge. Main was measured at each. */
const WIDTHS = [...Array.from({ length: 66 }, (_, i) => 360 + 24 * i), ...EDGE].sort((a, b) => a - b);

/**
 * The one place this layout may be taller than main, and by how much.
 *
 * Under 640px a CQL box takes a line of its own, with Run query and the rest on
 * the line under it. Main keeps the box beside the buttons, squeezed to about
 * 157px with its placeholder wrapped over three lines, for as long as the
 * buttons fit beside it. Just under 640px they still do, and there this header
 * is 20px taller than main's: on Timeline and Dashboard, at 628-639px in Linux
 * Chromium and 637-639px on a Mac. Accepted in review: the full-width box is
 * the better layout. Of the boards swept here, only Timeline is in it.
 */
const EXCEPTIONS: readonly { name: string; boards: readonly string[]; mode: Mode; from: number; to: number; maxDelta: number }[] = [
  { name: "CQL box on a line of its own under 640px", boards: ["timeline", "dashboard"], mode: "CQL", from: 628, to: 639, maxDelta: 20 },
];

/** How much taller than main a board may be in a mode at a width: 0 outside EXCEPTIONS. */
const allowance = (board: Board, mode: Mode, width: number) =>
  EXCEPTIONS.find((e) => e.boards.includes(board) && e.mode === mode && width >= e.from && width <= e.to)?.maxDelta ?? 0;

/**
 * The header's height at every width of the sweep. It resizes the page, so it
 * runs after a load's other checks (see openBoard).
 */
async function sweep(page: Page): Promise<Heights> {
  const out: Heights = {};
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    out[width] = await headerHeight(page);
  }
  return out;
}

/** The widths where `got` is taller than `than` by more than its allowance, as "768px: 113 > 81". */
const tallerThan = (got: Heights, than: Heights, board: Board, mode: Mode) =>
  WIDTHS.filter((w) => !(got[w] <= than[w] + allowance(board, mode, w) + ROUNDING)).map((w) => `${w}px: ${got[w]} > ${than[w]}`);

/** The widths where `got` differs from `was`, as "768px: 81 -> 113". */
const changedFrom = (got: Heights, was: Heights) =>
  WIDTHS.filter((w) => !(Math.abs(got[w] - was[w]) <= ROUNDING)).map((w) => `${w}px: ${was[w]} -> ${got[w]}`);

/** Sweep in the mode shown, then in the other: at no width taller than main, but as EXCEPTIONS allows. */
async function expectWithinMain(page: Page, slug: Board, at: string, first: Mode) {
  const main = (await mainHere(page))[slug];
  const got: Partial<Record<Mode, Heights>> = {};
  for (const mode of [first, first === "Filters" ? "CQL" : "Filters"] as const) {
    await useMode(page, mode);
    got[mode] = await sweep(page);
    expect(tallerThan(got[mode], main[mode], slug, mode), `${at} ${mode}: taller than main at`).toEqual([]);
  }
  return got as Record<Mode, Heights>;
}

/**
 * Neither "Run as a query" nor Clear moves the board: the header is the same
 * height at every width of the sweep with a query-like phrase typed (both
 * showing), with a search applied (Clear showing), and after Clear.
 *
 * As items of the row, each took a line of its own wherever the row was one
 * item short of full, and the board jumped: the suggestion as the phrase was
 * typed (Kanban at 1280: 49 -> 81px), Clear on the first filter (the sprint
 * board at 1280, 32px), and a Clear held in place while there was nothing to
 * clear cost the line all the time instead (768-810px on most boards).
 */
async function expectNoJump(page: Page, at: string, empty: Heights) {
  const search = page.getByRole("textbox", { name: "Search work items" });
  const suggestion = page.getByRole("button", { name: "Run as a query" });
  const clear = page.getByRole("button", { name: "Clear search and filters" });

  await search.click();
  await search.pressSequentially("priority = high");
  await expect(suggestion).toBeVisible();
  await expect(clear).toBeVisible();
  expect(changedFrom(await sweep(page), empty), `${at}: typing a query moved the board at`).toEqual([]);
  await expect(suggestion, "the suggestion went while the box still had focus").toBeVisible();

  await search.fill("review");
  await search.press("Enter");
  await expect(page.getByText("Gallery item in progress")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("Gallery item in review").first()).toBeVisible();
  await expect(suggestion).toHaveCount(0);
  expect(changedFrom(await sweep(page), empty), `${at}: applying a search moved the board at`).toEqual([]);

  await clear.click();
  await expect(page.getByText("Gallery item in progress").first()).toBeVisible({ timeout: 15_000 });
  await expect(search).toHaveValue("");
  await expect(clear).toHaveCount(0);
  expect(changedFrom(await sweep(page), empty), `${at}: clearing the search moved the board at`).toEqual([]);
}

/**
 * "Run as a query" is a suggestion: under the search box, on top of the board,
 * over none of the bar's controls, reached by keyboard straight after Clear,
 * put away by Escape, and it still runs the text as a query. On the sprint
 * board (its items say when a search has landed).
 */
async function expectSuggestion(page: Page, at: string) {
  const search = page.getByRole("textbox", { name: "Search work items" });
  const suggestion = page.getByRole("button", { name: "Run as a query" });
  const clear = page.getByRole("button", { name: "Clear search and filters" });
  await search.click();
  await search.pressSequentially("priority = high");
  await expect(suggestion).toBeVisible();

  const where = await suggestion.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const box = document.querySelector('input[aria-label="Search work items"]')!.getBoundingClientRect();
    const band = el.closest(".border-b")!;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const covered = [...band.querySelectorAll('button, input, select, textarea, a[href], [role="combobox"]')]
      .filter((c) => c !== el && !el.contains(c))
      .filter((c) => {
        const b = c.getBoundingClientRect();
        return b.width > 0 && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
      })
      .map((c) => (c.getAttribute("aria-label") || c.textContent || c.tagName).trim());
    return { onTop: !!hit && (hit === el || el.contains(hit)), covered, under: r.top >= box.bottom, left: r.left - box.left };
  });
  expect(where.onTop, `${at}: the suggestion is under something`).toBe(true);
  expect(where.covered, `${at}: the suggestion covers the bar's controls`).toEqual([]);
  expect(where.under, `${at}: the suggestion is not under the search box`).toBe(true);
  expect(Math.abs(where.left), `${at}: the suggestion is not at the search box's left edge`).toBeLessThanOrEqual(1);

  // Keyboard: the box, then Clear, then the suggestion. Leaving the box
  // applies the phrase as a search (any blur does): let that land first, or
  // the box is reset to it under the next thing typed (as on main).
  await page.keyboard.press("Tab");
  await expect(clear).toBeFocused();
  await expect(page.getByText("Gallery item in progress")).toHaveCount(0, { timeout: 15_000 });
  await page.keyboard.press("Tab");
  await expect(suggestion).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(suggestion).toHaveCount(0);
  await expect(search).toBeFocused();
  await clear.click();
  await expect(page.getByText("Gallery item in progress").first()).toBeVisible({ timeout: 15_000 });
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  // Pressed, it runs the text as a query.
  await search.pressSequentially("priority = MEDIUM");
  await suggestion.click();
  await expect(page.getByRole("button", { name: "CQL" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Query" })).toContainText("priority = MEDIUM");
  // Clear is in the query box in CQL too; it empties the query.
  await clear.click();
  await expect(clear).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("cql")).toBeNull();
}

test.describe("Board header — fewer rows", () => {
  test.afterAll(async ({ browser }) => {
    await resetQueryLanguage(browser);
  });

  test.beforeEach(async ({ page, signInAs }) => {
    await signInAs(EMAIL);
    await setQueryLanguage(page.request, true);
  });

  test("scrum at 1280: within budget in both modes, every moved control works, never taller than main, and a search never moves the board", async ({ page }) => {
    test.setTimeout(240_000);
    await openBoard(page, "scrum", { width: 1280, height: 800 });

    await useMode(page, "Filters");
    await expectBudget(page, "scrum@1280 Filters", { main: 150, own: 126 });
    await expectControls(page, "scrum@1280 Filters", [...queryBar(page, "Filters"), ...scrumControls(page)]);
    await expectSuggestion(page, "scrum@1280");

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
    await expectBudget(page, "scrum@1280 CQL", { main: 187.6, own: 131.6 });
    await expectControls(page, "scrum@1280 CQL", [...queryBar(page, "CQL"), ...scrumControls(page)]);

    // Last, because they resize the page.
    const swept = await expectWithinMain(page, "scrum", "scrum (loaded at 1280)", "CQL");
    await expectNoJump(page, "scrum (loaded at 1280) Filters", swept.Filters);
  });

  test("scrum on a phone: within main's height, and the CQL box gets a line of its own", async ({ page }) => {
    test.setTimeout(150_000);
    await openBoard(page, "scrum", PHONE);
    await useMode(page, "Filters");
    await expectBudget(page, "scrum@390 Filters", { main: 258, own: 254 });
    await expectControls(page, "scrum@390 Filters", [...queryBar(page, "Filters"), ...scrumControls(page)]);

    await useMode(page, "CQL");
    await expectBudget(page, "scrum@390 CQL", { main: 712, own: 360 });
    await expectControls(page, "scrum@390 CQL", [...queryBar(page, "CQL"), ...scrumControls(page)]);
    // It was about 45px wide: Run query and Format took the line first, and
    // the placeholder wrapped a few letters per line.
    const box = (await page.getByRole("textbox", { name: "Query" }).boundingBox())!;
    expect(box.width).toBeGreaterThan(200);
    const run = (await page.getByRole("button", { name: /Run query/ }).boundingBox())!;
    expect(run.y, "Run query is beside the query box, not under it").toBeGreaterThanOrEqual(box.y + box.height - 1);

    await expectWithinMain(page, "scrum", "scrum (loaded at 390)", "CQL");
  });

  for (const [size, budget] of [
    [{ width: 1024, height: 768 }, { Filters: { main: 145, own: 141 }, CQL: { main: 202.2, own: 198.2 } }],
    [PHONE, { Filters: { main: 243, own: 235 }, CQL: { main: 697, own: 341 } }],
  ] as const) {
    test(`timeline at ${size.width}: its long toolbar wraps within budget, and never taller than main`, async ({ page }) => {
      test.setTimeout(150_000);
      await openBoard(page, "timeline", size);
      for (const mode of ["Filters", "CQL"] as const) {
        const at = `timeline@${size.width} ${mode}`;
        await useMode(page, mode);
        await expectBudget(page, at, budget[mode]);
        await expectControls(page, at, [...queryBar(page, mode), ...timelineControls(page)]);
      }
      await expectWithinMain(page, "timeline", `timeline (loaded at ${size.width})`, "CQL");
    });
  }

  test("table on a phone: within budget, with its own toolbar, and never taller than main", async ({ page }) => {
    test.setTimeout(150_000);
    await openBoard(page, "table", PHONE);
    const table = (p: Page): [string, Locator][] => [
      ["Group by", p.getByRole("combobox", { name: "Group by" })],
      ["Comfortable rows", p.getByRole("button", { name: "Comfortable rows" })],
      ["Compact rows", p.getByRole("button", { name: "Compact rows" })],
      newWorkItem(p),
    ];
    for (const [mode, budget] of [
      ["Filters", { main: 149, own: 113 }],
      ["CQL", { main: 603, own: 219 }],
    ] as const) {
      await useMode(page, mode);
      await expectBudget(page, `table@390 ${mode}`, budget);
      await expectControls(page, `table@390 ${mode}`, [...queryBar(page, mode), ...table(page)]);
    }
    await expectWithinMain(page, "table", "table (loaded at 390)", "CQL");
  });
});
