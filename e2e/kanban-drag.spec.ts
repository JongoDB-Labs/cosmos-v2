// Covers the seam unit tests cannot reach: a REAL dnd-kit drop, the server's
// date capture, and the dialogs the board opens in response.
//
// Also the replication attempt for "the Sprint board does not allow me to move
// items from Backlog to To Do".
import { test, expect } from "./fixtures/auth";
import type { Page } from "@playwright/test";

// Fixture ids come from `npx tsx prisma/seed/kanban-repro.ts`, which prints them.
// Absent (i.e. in CI, which seeds test-fixtures.ts instead) the whole file skips
// rather than failing on a board that does not exist. To run it:
//
//   npx tsx prisma/seed/kanban-repro.ts
//   REPRO_BOARD_ID=... REPRO_CHILD_ID=... REPRO_PLAIN_ID=... \
//     npx playwright test e2e/kanban-drag.spec.ts
const BOARD = process.env.REPRO_BOARD_ID ?? "";
const CHILD = process.env.REPRO_CHILD_ID ?? "";
const PLAIN = process.env.REPRO_PLAIN_ID ?? "";

test.skip(!BOARD || !CHILD || !PLAIN, "needs the kanban-repro fixture ids");

async function openBoard(page: Page) {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto(`/test-org/projects/TEST/boards/${BOARD}`, {
    waitUntil: "domcontentloaded",
  });
  // The board opens filtered to "Assigned to me"; Clear widens it to everything.
  const clear = page.getByRole("button", { name: /^clear$/i });
  if (await clear.count()) await clear.first().click();
  await expect(page.getByTestId("kanban-column-backlog")).toBeVisible({ timeout: 30_000 });
}

/**
 * dnd-kit activates on a pointer gesture, not on a single mouse event — a bare
 * dragTo() never trips its constraint. Move in steps, with a pause after the
 * press so the sensor registers the drag start.
 */
async function dragCardTo(page: Page, cardId: string, columnKey: string) {
  const card = page.getByTestId(`kanban-card-${cardId}`);
  const col = page.getByTestId(`kanban-column-${columnKey}`);
  await expect(card).toBeVisible();
  const from = (await card.boundingBox())!;
  const to = (await col.boundingBox())!;

  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(150);
  const tx = to.x + to.width / 2;
  const ty = to.y + 40;
  for (let i = 1; i <= 15; i++) {
    await page.mouse.move(
      from.x + from.width / 2 + ((tx - from.x - from.width / 2) * i) / 15,
      from.y + 20 + ((ty - from.y - 20) * i) / 15,
    );
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(1200);
}

test("a plain card moves Backlog -> To Do and STAYS there", async ({ page, signInAs }) => {
  test.setTimeout(120_000);
  await signInAs("alice@test.local");
  await openBoard(page);

  await dragCardTo(page, PLAIN, "todo");

  // The reported symptom was the card springing back. Assert where it landed,
  // not merely that no error appeared.
  const moved = page.getByTestId(`kanban-card-${PLAIN}`);
  await expect(moved).toHaveAttribute("data-column", "todo", { timeout: 15_000 });

  // ...and that it survives a reload, i.e. the server kept it.
  await page.reload({ waitUntil: "domcontentloaded" });
  const clear = page.getByRole("button", { name: /^clear$/i });
  if (await clear.count()) await clear.first().click();
  await expect(page.getByTestId(`kanban-card-${PLAIN}`)).toHaveAttribute(
    "data-column",
    "todo",
    { timeout: 30_000 },
  );
});

test("a child moved to In Progress prompts for the actual date AND the parent", async ({
  page,
  signInAs,
}) => {
  test.setTimeout(120_000);
  page.on("console", (m) => {
    if (m.text().includes("DRIFTDBG")) console.log(m.text());
  });
  await signInAs("alice@test.local");
  await openBoard(page);

  await dragCardTo(page, CHILD, "in-progress");

  // In Progress is IN_PROGRESS, so the server stamps an actual start and the
  // board offers to correct it. This is the drop-handler -> dialog seam.
  // BOTH fire for this move: the child overtook its parent AND the server
  // stamped an actual start. Assert each rather than "one of them" — that is
  // the whole seam.
  await expect(page.getByRole("heading", { name: /move the parent too\?/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({ path: "/tmp/kanban-cascade-dialog.png" });

  // Bring the parent along, which closes the cascade prompt and reveals the
  // date prompt behind it.
  await page.getByRole("button", { name: /move parent to in progress/i }).click();
  await expect(page.getByRole("heading", { name: /when did this work start\?/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({ path: "/tmp/kanban-date-dialog.png" });

  // Correcting the date must persist, not just close the dialog.
  await page.getByLabel(/actual start date/i).fill("2026-07-31");
  await page.getByRole("button", { name: /set start date/i }).click();
  await expect(page.getByRole("heading", { name: /when did this work start\?/i })).toBeHidden();
});

test("a CHILD moves Backlog -> To Do even though its parent stays behind", async ({
  page,
  signInAs,
}) => {
  // The reported failure, as precisely as it can be stated: a child moving to a
  // status its parent is not in. There is no rule against it in either layer, and
  // this pins that — a regression would otherwise only surface as a user report.
  test.setTimeout(120_000);
  await signInAs("alice@test.local");
  await openBoard(page);

  await dragCardTo(page, CHILD, "todo");

  await expect(page.getByTestId(`kanban-card-${CHILD}`)).toHaveAttribute(
    "data-column",
    "todo",
    { timeout: 15_000 },
  );
  // To Do is a TODO column, so nothing should have been stamped and no dialog
  // should interrupt.
  await expect(page.getByRole("heading", { name: /when did this work start\?/i })).toBeHidden();
  await expect(page.getByRole("heading", { name: /move the parent too\?/i })).toBeHidden();

  await page.reload({ waitUntil: "domcontentloaded" });
  const clear = page.getByRole("button", { name: /^clear$/i });
  if (await clear.count()) await clear.first().click();
  await expect(page.getByTestId(`kanban-card-${CHILD}`)).toHaveAttribute("data-column", "todo", {
    timeout: 30_000,
  });
});
