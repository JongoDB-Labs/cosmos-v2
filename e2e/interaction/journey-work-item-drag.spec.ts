import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/auth";

/**
 * E2E interaction journey — drag a kanban card from one column to another.
 *
 * INTENTIONALLY ISOLATED & NON-GATING. dnd-kit pointer drags are inherently
 * timing-sensitive (PointerSensor activation distance + the live
 * handleDragOver reorder + the persist PUT), so this spec is flaky enough that
 * it must not block PRs. It lives under e2e/interaction/ and is excluded from
 * the gated `e2e` run via `testIgnore` (see playwright.config.ts); only the
 * informational `e2e-interaction` CI job (continue-on-error) collects it, by
 * setting E2E_INCLUDE_INTERACTION=1.
 *
 * Strategy:
 *  - Seed the board with two cards via the inline quick-create: one in the
 *    first column ("Backlog") and one in the target column ("To Do"). The
 *    target card gives us an EXISTING droppable to land on (dnd-kit needs a
 *    sortable to compute the drop position) and proves the move is a real
 *    cross-column reorder rather than a drop onto an empty column.
 *  - Drive a dnd-kit-correct pointer sequence: mouse.down on the source card,
 *    a small jiggle past the 5px PointerSensor activation distance
 *    (kanban-board.tsx:157), then move to the target card in several steps so
 *    the collision detection + handleDragOver fire, a short settle, then up.
 *  - Gate success on the persist PUT 200 (page.waitForResponse on
 *    PUT **\/work-items\/*) — handleDragEnd (kanban-board.tsx:205-287) fires
 *    fetch(... PUT /work-items/{id}) — rather than purely on the visual move,
 *    which is the flaky part. A 200 means the server accepted the new
 *    columnKey/sortOrder.
 *
 * Needs the seeded "TEST" project + its default KANBAN board (columns
 * Backlog/To Do/In Progress/Review/Done) and the built-in "software.task"
 * WorkItemType — all in prisma/seed/test-fixtures.ts. Mutating → verified in
 * the e2e-interaction CI job. Unique titles per run.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const PROJECT_KEY = process.env.E2E_PROJECT_KEY ?? "test";

// Seeded board column display names (prisma/seed/test-fixtures.ts).
const SOURCE_COLUMN_INDEX = 0; // "Backlog"
const TARGET_COLUMN_INDEX = 1; // "To Do"

/** Reveal the nth column's inline quick-create, type a title, submit, and
 *  return once the card's accessible button ("Open …: {title}") is visible. */
async function createCard(page: Page, columnIndex: number, title: string) {
  await page
    .getByRole("button", { name: "Add card" })
    .nth(columnIndex)
    .click();
  // The quick-create input is column-scoped, but only one is open at a time.
  const titleInput = page.getByPlaceholder("Card title...");
  await expect(titleInput).toBeVisible({ timeout: 10_000 });
  await titleInput.fill(title);
  await titleInput.press("Enter");
  const card = page.getByRole("button", { name: title }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  return card;
}

test.describe("interaction — work item drag (non-gating, flaky)", () => {
  test("drag a card onto a card in another column and persist (PUT 200)", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(90_000);
    await signInAs(EMAIL);

    const stamp = Date.now().toString().slice(-6);
    const sourceTitle = `E2E Drag SRC ${stamp}`;
    const targetTitle = `E2E Drag DST ${stamp}`;

    // /projects/<key> redirects to the project's default (first) board.
    await page.goto(`/${ORG}/projects/${PROJECT_KEY}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .waitForURL(/\/boards\/[0-9a-f-]{36}$/i, { timeout: 20_000 })
      .catch(() => {});
    await page.waitForSelector("main", { timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: "Backlog" }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // Seed a card in the TARGET column first (so it's an existing droppable),
    // then the SOURCE card we'll drag. Create target first to keep the source
    // card the most-recently-created (avoids accidental quick-create overlap).
    const targetCard = await createCard(page, TARGET_COLUMN_INDEX, targetTitle);
    const sourceCard = await createCard(page, SOURCE_COLUMN_INDEX, sourceTitle);

    // Resolve geometry for the dnd-kit-correct pointer sequence.
    const src = await sourceCard.boundingBox();
    const dst = await targetCard.boundingBox();
    expect(src, "source card bounding box").toBeTruthy();
    expect(dst, "target card bounding box").toBeTruthy();
    if (!src || !dst) return; // narrow for TS; the expects above already failed.

    const srcX = src.x + src.width / 2;
    const srcY = src.y + src.height / 2;
    const dstX = dst.x + dst.width / 2;
    const dstY = dst.y + dst.height / 2;

    // Arm the persist assertion BEFORE the drop: handleDragEnd fires a PUT to
    // /work-items/{id}. We gate success on this 200 rather than the (flaky)
    // visual move. Generous timeout — the whole gesture + request round-trips.
    const persisted = page.waitForResponse(
      (res) =>
        res.request().method() === "PUT" &&
        /\/work-items\/[^/?]+(?:\?.*)?$/.test(res.url()),
      { timeout: 30_000 },
    );

    // dnd-kit pointer drag:
    //  1. press on the source card
    //  2. nudge >5px to cross the PointerSensor activation distance
    //     (kanban-board.tsx:157 — { distance: 5 })
    //  3. move to the target card in steps so closestCorners collision +
    //     handleDragOver run and select the over-item
    //  4. settle so dnd-kit's measuring stabilizes, then release
    await page.mouse.move(srcX, srcY);
    await page.mouse.down();
    // Cross the 5px activation threshold (10px is comfortably past it).
    await page.mouse.move(srcX + 10, srcY + 10, { steps: 6 });
    // Travel to the target card center in several steps.
    await page.mouse.move(dstX, dstY, { steps: 20 });
    // Hover on the target a moment so the over computation settles, then nudge
    // once more to ensure the final onDragOver reflects the target column.
    await page.mouse.move(dstX, dstY + 2, { steps: 4 });
    await page.mouse.up();

    // The drag-end handler must have persisted the move with a 200.
    const res = await persisted;
    expect(
      res.status(),
      `PUT ${res.url()} should persist the moved card`,
    ).toBe(200);
  });
});
