import { test, expect } from "./fixtures/auth";

/**
 * On a touch screen a card's ⋯ menu is always shown, at a 32px tap target
 * (ActionMenu's coarse-pointer size), so the card's top row must leave room for
 * it: a long title wraps short of the ⋯ instead of running under it. With room
 * for the 24px mouse-sized trigger only, a kanban card's title ran 5px under it.
 *
 * Read-only: the seeded GALLERY kanban's own cards (as board-header-compact
 * does), measured in the browser with touch on, which is what makes the
 * pointer coarse.
 */
const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const GALLERY = process.env.E2E_GALLERY_PROJECT_KEY ?? "GALLERY";

test.use({ hasTouch: true });

test("a kanban card's title stops short of its ⋯ on a touch screen", async ({ page, signInAs }) => {
  test.setTimeout(60_000);
  await signInAs("alice@test.local");
  await page.goto(`/${ORG}/projects/${GALLERY}/boards/kanban`, { waitUntil: "domcontentloaded" });
  const cards = page.locator('[data-testid^="kanban-card-"]');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);

  const measured = await cards.evaluateAll((all) =>
    all.map((card) => {
      const trigger = card.nextElementSibling as HTMLElement; // ActionMenu renders the ⋯ right after the card
      const title = card.querySelector("h3") as HTMLElement;
      const t = trigger.getBoundingClientRect();
      const h = title.getBoundingClientRect();
      return { trigger: Math.round(t.width), titleRight: h.right, triggerLeft: t.left, rowsMeet: h.top < t.bottom && h.bottom > t.top };
    }),
  );
  expect(measured.length).toBeGreaterThan(0);
  for (const m of measured) {
    expect(m.trigger).toBe(32); // the touch-sized ⋯, so this is the case being tested
    expect(m.rowsMeet).toBe(true); // the title shares the ⋯'s row
    expect(m.titleRight).toBeLessThanOrEqual(m.triggerLeft);
  }
});
