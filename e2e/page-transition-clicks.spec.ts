import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/auth";

/**
 * A click made while the page cross-fades must land.
 *
 * Every navigation runs a view transition (ui/page-transition.tsx): the
 * browser's own 250 ms fade of the whole document (the `root` group) plus our
 * `page` fade in globals.css. While one runs, the browser hit-tests the
 * `::view-transition` overlay drawn over the page, not the page, so for about
 * a quarter of a second after every navigation a click on anything at all,
 * sidebar included, reached `<html>` and did nothing.
 *
 * The cross-fade is stretched here so the click is certain to land inside it.
 * What is under test is who receives the pointer while a transition runs, not
 * how long one runs. The click is `page.mouse.click` at the link's centre,
 * never `locator.click()`: Playwright's own hit check would see `<html>` in the
 * way, wait for the transition to end, and then click, passing either way.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

/** True while any view-transition pseudo-element is animating. */
const transitioning = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .some((a) => String((a.effect as KeyframeEffect | null)?.pseudoElement ?? "").startsWith("::view-transition")),
  );

test("a click made during the page cross-fade reaches what it was aimed at", async ({ page, signInAs }) => {
  await signInAs(EMAIL);
  // A full load: client navigation needs a hydrated page.
  await page.goto(`/${ORG}`);
  await page.waitForSelector("main", { timeout: 20_000 });
  await page.addStyleTag({
    content: "::view-transition-old(page), ::view-transition-new(page) { animation-duration: 5s !important; }",
  });

  await page.locator(`nav a[href="/${ORG}/projects"]`).first().click();
  // Positive control: a transition really is running. Without one this test
  // would pass on any build, the broken one included.
  await expect.poll(() => transitioning(page), { timeout: 15_000, intervals: [50] }).toBe(true);

  const target = page.locator(`nav a[href="/${ORG}/work-items"]`).first();
  const box = await target.boundingBox();
  expect(box, "the Work Items link has no box to click").not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;

  // Who the browser says is under the pointer right now. It was `HTML`.
  const hit = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest("a")?.getAttribute("href") ?? null, [x, y]);
  await page.mouse.click(x, y);
  // Still inside the transition after the click, so the click was made in it.
  expect(await transitioning(page), "the transition ended before the click; nothing was tested").toBe(true);

  expect(hit, "mid-transition, the point over the Work Items link hit something else").toBe(`/${ORG}/work-items`);
  await expect(page).toHaveURL(new RegExp(`/${ORG}/work-items(\\?|$)`), { timeout: 15_000 });
});
