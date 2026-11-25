import { test, expect } from "./fixtures/auth";
import type { Locator, Page } from "@playwright/test";

/**
 * The assistant drawer, its corner button and the minimized side tab against
 * the rest of the page.
 *
 * The bugs here are about STACKING — the drawer still "visible" while a
 * full-screen view covered it, a Save button hidden under an open drawer — so
 * the assertions ask what is topmost at a control's centre
 * (`document.elementFromPoint`), not just whether it is visible.
 *
 * Read-only against the shared test DB: preference saves are answered by a
 * route stub, and the assistant is never sent a message.
 */

const ORG = "test-org";
const EMAIL = "alice@test.local";
const TIMELINE = `/${ORG}/projects/GALLERY/boards/timeline`;
const KANBAN = `/${ORG}/projects/GALLERY/boards/kanban`;
const TABLE = `/${ORG}/projects/GALLERY/boards/table`;
const REVIEW = `/${ORG}/projects/GALLERY/boards/sprint-review`;
const PREFS = `/${ORG}/settings/preferences`;

const LAUNCHER = /^Open COSMOS/;
const CORNER_MINIMIZE = /^Minimize COSMOS .* to the side$/;
const RESTORE = /^Restore COSMOS/;

/** Is the element at `loc`'s centre `loc` itself (or inside it)? */
async function isTopmost(page: Page, loc: Locator): Promise<boolean> {
  const box = await loc.boundingBox();
  if (!box) return false;
  const handle = await loc.elementHandle();
  return page.evaluate(
    ([x, y, el]) => {
      const hit = document.elementFromPoint(x as number, y as number);
      return !!hit && ((el as Element) === hit || (el as Element).contains(hit));
    },
    [box.x + box.width / 2, box.y + box.height / 2, handle] as const,
  );
}

function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function gotoReady(page: Page, path: string) {
  await page.goto(path);
  await page.waitForSelector("main", { timeout: 30_000 });
}

/** Clicks before hydration are dropped, so retry until the drawer is there. */
async function openAssistant(page: Page) {
  const drawer = page.getByRole("complementary", { name: "assistant drawer" });
  await expect(async () => {
    await page.getByRole("button", { name: "Open assistant" }).click();
    await expect(drawer).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return drawer;
}

async function composer(page: Page) {
  const box = page
    .getByRole("complementary", { name: "assistant drawer" })
    .getByPlaceholder(/type a message/i);
  await expect(box).toBeEnabled({ timeout: 20_000 });
  return box;
}

/**
 * Make Preferences dirty so its fixed "Unsaved changes" bar shows. The form's
 * initial load can reset an edit made before it lands, so the bar must still
 * be there a moment later.
 */
async function dirtyPreferences(page: Page) {
  await expect(async () => {
    await page.getByPlaceholder("Optional").first().fill(`x${Date.now()}`);
    await page.waitForTimeout(1_500);
    await expect(page.getByText("Unsaved changes")).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 30_000 });
}

/** Type an @-mention and wait for its list (retried: the panel may still be loading). */
async function openMentionList(input: Locator, list: Locator) {
  await expect(async () => {
    await input.fill("");
    await input.pressSequentially("@Falcon");
    await expect(list).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

test.describe("assistant panel layering", () => {
  test.beforeEach(async ({ signInAs, page }) => {
    await signInAs(EMAIL);
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("a full-screen timeline does not hide the open drawer", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoReady(page, TIMELINE);
    const drawer = await openAssistant(page);
    await page.getByRole("button", { name: "Enter fullscreen" }).click();
    const exit = page.getByRole("button", { name: "Exit fullscreen" });
    await expect(exit).toBeVisible();

    await expect.poll(() => isTopmost(page, drawer.getByRole("button", { name: "Close drawer" }))).toBe(true);
    await expect.poll(() => isTopmost(page, exit)).toBe(true);

    // Closed: the corner button sits above the full-screen view.
    await drawer.getByRole("button", { name: "Close drawer" }).click();
    const launcher = page.getByRole("button", { name: LAUNCHER });
    await expect(launcher).toBeVisible();
    await expect.poll(() => isTopmost(page, launcher)).toBe(true);
    // ...and the view keeps the corner strip free, so it never covers content.
    const root = await page.getByTestId("gantt-root").boundingBox();
    const contentBottom = await page.getByTestId("gantt-root").evaluate((el) => {
      const pb = parseFloat(getComputedStyle(el).paddingBottom);
      return el.getBoundingClientRect().bottom - pb;
    });
    const lb = await launcher.boundingBox();
    expect(root && lb).toBeTruthy();
    expect(lb!.y).toBeGreaterThanOrEqual(contentBottom - 1);
  });

  test("Present mode does not hide the open drawer", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoReady(page, REVIEW);
    const drawer = await openAssistant(page);
    await page.getByRole("button", { name: "Present" }).click();
    const exit = page.getByRole("button", { name: "Exit presentation" });
    await expect(exit).toBeVisible();
    await expect.poll(() => isTopmost(page, drawer.getByRole("button", { name: "Close drawer" }))).toBe(true);
    await expect.poll(() => isTopmost(page, exit)).toBe(true);
  });

  test("the Preferences save bar stays usable beside an open drawer", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("**/api/v1/orgs/*/preferences", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await route.fulfill({ status: 200, contentType: "application/json", body: route.request().postData() ?? "{}" });
    });
    await gotoReady(page, PREFS);
    await dirtyPreferences(page);
    await page.locator("header").getByRole("button", { name: "Notes" }).first().click();
    await expect(page.getByRole("complementary", { name: "notes drawer" })).toBeVisible();

    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect.poll(() => isTopmost(page, save)).toBe(true);
    await save.click();
    await expect(page.getByText("Unsaved changes")).toBeHidden();
  });

  test("toasts do not sit on the drawer's header buttons", async ({ page }) => {
    await page.route("**/api/v1/orgs/*/preferences", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"nope"}' });
    });
    for (const [vw, vh, wide] of [
      [1440, 900, false],
      [1024, 768, true],
    ] as const) {
      await page.setViewportSize({ width: vw, height: vh });
      await gotoReady(page, PREFS);
      await dirtyPreferences(page);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const drawer = await openAssistant(page);
      if (wide) await drawer.getByRole("button", { name: "Expand drawer" }).click();
      const toast = page.locator("[data-sonner-toast]").first();
      await expect(toast).toBeVisible();
      await page.waitForTimeout(400);
      const t = (await toast.boundingBox())!;
      const buttons = (await drawer.getByRole("button", { name: "Close drawer" }).boundingBox())!;
      const minimize = (await drawer.getByRole("button", { name: "Minimize drawer" }).boundingBox())!;
      expect(intersects(t, buttons)).toBe(false);
      expect(intersects(t, minimize)).toBe(false);
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x + t.width).toBeLessThanOrEqual(vw);
      if (!wide) {
        const header = (await drawer.locator("> div").nth(1).boundingBox())!;
        expect(intersects(t, header)).toBe(false);
      }
    }
  });

  test("the corner button keeps one position", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const path of [PREFS, KANBAN]) {
      await gotoReady(page, path);
      const launcher = page.getByRole("button", { name: LAUNCHER });
      await expect(launcher).toBeVisible();
      await page.waitForTimeout(1_000);
      const home = { x: 1440 - 24 - 48, y: 900 - 24 - 48 };
      for (let i = 0; i < 4; i++) {
        const b = (await launcher.boundingBox())!;
        expect(Math.round(b.x)).toBe(home.x);
        expect(Math.round(b.y)).toBe(home.y);
        await page.mouse.move(700, 450);
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(300);
      }
    }
  });

  test("minimize keeps the draft and frees the corner", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoReady(page, `/${ORG}`);
    const drawer = await openAssistant(page);
    const input = await composer(page);
    await input.fill("half-written question");

    await drawer.getByRole("button", { name: "Minimize drawer" }).click();
    const tab = page.getByRole("button", { name: RESTORE });
    await expect(tab).toBeVisible();
    await expect(tab).toBeFocused();
    await expect(drawer).toBeHidden();

    await tab.click();
    await expect(drawer).toBeVisible();
    await expect(input).toHaveValue("half-written question");
    await expect(input).toBeFocused();

    // Escape inside the drawer minimizes; it does not close.
    await page.keyboard.press("Escape");
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(input).toHaveValue("half-written question");
    await drawer.getByRole("button", { name: "Close drawer" }).click();

    // From the corner: its minimize control frees the corner entirely.
    await page.getByRole("button", { name: CORNER_MINIMIZE }).click();
    await expect(tab).toBeFocused();
    const hit = await page.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth - 48, window.innerHeight - 48);
      return {
        assistant: !!el?.closest("aside, #cosmos-drawer-tab, [aria-label^='Open COSMOS']"),
        main: !!el?.closest("main"),
      };
    });
    expect(hit).toEqual({ assistant: false, main: true });
  });

  test("one Escape, one action", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoReady(page, TIMELINE);
    const drawer = await openAssistant(page);
    const input = await composer(page);
    const list = page.getByText("Falcon radar upgrade");

    // An open @-list closes; the drawer stays.
    await openMentionList(input, list);
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(drawer).toBeVisible();

    // In fullscreen, Escape in the composer minimizes the drawer only.
    await input.fill("");
    await page.getByRole("button", { name: "Enter fullscreen" }).click();
    const exit = page.getByRole("button", { name: "Exit fullscreen" });
    await expect(exit).toBeVisible();
    await input.focus();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(exit).toBeVisible();

    // ...and with the list open, only the list closes.
    await page.getByRole("button", { name: RESTORE }).click();
    await expect(drawer).toBeVisible();
    await openMentionList(input, list);
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(drawer).toBeVisible();
    await expect(exit).toBeVisible();
  });

  test("the minimized tab is remembered across a reload", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoReady(page, `/${ORG}`);
    const drawer = await openAssistant(page);
    await drawer.getByRole("button", { name: "Minimize drawer" }).click();
    await page.reload();
    await page.waitForSelector("main");
    const tab = page.getByRole("button", { name: RESTORE });
    await expect(tab).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: LAUNCHER })).toHaveCount(0);

    await tab.click();
    await drawer.getByRole("button", { name: "Close drawer" }).click();
    await page.reload();
    await page.waitForSelector("main");
    await expect(page.getByRole("button", { name: LAUNCHER })).toBeVisible({ timeout: 20_000 });
    await expect(tab).toHaveCount(0);
  });

  test("phone: minimizing gives back the bottom nav, and Save is reachable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReady(page, `/${ORG}`);
    const drawer = page.getByRole("complementary", { name: "assistant drawer" });
    await expect(async () => {
      await page.getByRole("button", { name: LAUNCHER }).click();
      await expect(drawer).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await drawer.getByRole("button", { name: "Minimize drawer" }).click();
    const tab = page.getByRole("button", { name: RESTORE });
    await expect(tab).toBeVisible();

    // `next dev`'s own indicator sits over the bottom-left corner; it is not
    // app UI and does not exist in production.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    const nav = page.getByRole("navigation", { name: "Primary (mobile)" });
    const links = nav.getByRole("link");
    for (let i = 0; i < (await links.count()); i++) {
      await expect.poll(() => isTopmost(page, links.nth(i))).toBe(true);
    }
    expect(intersects((await tab.boundingBox())!, (await nav.boundingBox())!)).toBe(false);

    // Back to the corner button: the save bar is clear of it.
    await tab.click();
    await drawer.getByRole("button", { name: "Close drawer" }).click();
    await gotoReady(page, PREFS);
    await dirtyPreferences(page);
    await expect.poll(() => isTopmost(page, page.getByRole("button", { name: "Save", exact: true }))).toBe(true);
  });

  test("bulk-action bars clear the corner button", async ({ page }) => {
    for (const [vw, vh] of [
      [1440, 600],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width: vw, height: vh });
      for (const path of [`/${ORG}/work-items`, TABLE]) {
        await gotoReady(page, path);
        const row = page.getByRole("checkbox", { name: "Select row" }).first();
        // The floating bulk-action bar (the table header also says "N selected").
        const bar = page.locator(".sticky.bottom-4 > div").filter({ hasText: /\d+ selected/ });
        await expect(async () => {
          await row.check();
          await expect(bar).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
        await page.locator("main").evaluate((el) => el.scrollTo(0, 0));
        await page.waitForTimeout(300);
        const launcher = page.getByRole("button", { name: LAUNCHER });
        const b = (await bar.boundingBox())!;
        const l = (await launcher.boundingBox())!;
        expect(intersects(b, l), `${path} at ${vw}px`).toBe(false);
        // Not lifted twice: the bar still sits near the bottom of the screen.
        if (b.y + b.height > vh / 2) {
          expect(vh - (b.y + b.height)).toBeLessThan(vw < 768 ? 180 : 120);
        }
        for (const btn of await bar.getByRole("button").all()) {
          if (await btn.isVisible()) await expect.poll(() => isTopmost(page, btn)).toBe(true);
        }
      }
    }
  });
});
