// "Unable to move cards INTO To Do from the other columns."
//
// Distinct from the earlier report, which was read as Backlog -> To Do and does
// not reproduce. This treats To Do as the DESTINATION from every other column,
// including backward moves out of In Progress / Review / Done — the direction
// nothing had covered.
import { test, expect } from "./fixtures/auth";
import type { Page } from "@playwright/test";

const BOARD = process.env.REPRO_BOARD_ID ?? "";
const PLAIN = process.env.REPRO_PLAIN_ID ?? "";

test.skip(!BOARD || !PLAIN, "needs the kanban-repro fixture ids");

async function openBoard(page: Page) {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto(`/test-org/projects/TEST/boards/${BOARD}`, {
    waitUntil: "domcontentloaded",
  });
  const clear = page.getByRole("button", { name: /^clear$/i });
  if (await clear.count()) await clear.first().click();
  await expect(page.getByTestId("kanban-column-backlog")).toBeVisible({ timeout: 30_000 });
}

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

async function parkInColumn(page: Page, itemId: string, columnKey: string) {
  const origin = new URL(page.url()).origin;
  await page.evaluate(
    async ({ itemId, columnKey }) => {
      const j = async (u: string) => (await (await fetch(u)).json());
      const orgs = await j("/api/v1/orgs");
      const org = (orgs.data ?? orgs).find((o: { slug: string }) => o.slug === "test-org");
      const projects = await j(`/api/v1/orgs/${org.id}/projects`);
      const project = (projects.data ?? projects).find((p: { key: string }) => p.key === "TEST");
      await fetch(`/api/v1/orgs/${org.id}/projects/${project.id}/work-items/${itemId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ columnKey }),
      });
    },
    { itemId, columnKey },
  );
  void origin;
}

/** Dismiss whichever prompt a move may have raised, so it cannot mask a failure. */
async function dismissPrompts(page: Page) {
  for (const name of [/leave the parent/i, /keep today/i]) {
    const b = page.getByRole("button", { name });
    if (await b.count()) await b.first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

for (const origin of ["in-progress", "review", "done"]) {
  test(`a card moves BACKWARD from ${origin} into To Do`, async ({ page, signInAs }) => {
    test.setTimeout(120_000);
    await signInAs("alice@test.local");
    await openBoard(page);

    // Park it in the origin column via the API, not a drag: the Done column sits
    // at the far right of a horizontally scrollable board, so DRAGGING into it is
    // unreliable in a fixed viewport and would fail the setup rather than the
    // move under test.
    await parkInColumn(page, PLAIN, origin);
    await page.reload({ waitUntil: "domcontentloaded" });
    const c0 = page.getByRole("button", { name: /^clear$/i });
    if (await c0.count()) await c0.first().click();
    await expect(page.getByTestId(`kanban-card-${PLAIN}`)).toHaveAttribute(
      "data-column",
      origin,
      { timeout: 20_000 },
    );
    // Bring the card's column into view so the drag has real coordinates.
    await page.getByTestId(`kanban-card-${PLAIN}`).scrollIntoViewIfNeeded();

    // The move under test.
    await dragCardTo(page, PLAIN, "todo");
    await dismissPrompts(page);

    await expect(page.getByTestId(`kanban-card-${PLAIN}`)).toHaveAttribute(
      "data-column",
      "todo",
      { timeout: 15_000 },
    );

    // And it must SURVIVE — the reported symptom is a card that springs back.
    await page.reload({ waitUntil: "domcontentloaded" });
    const clear = page.getByRole("button", { name: /^clear$/i });
    if (await clear.count()) await clear.first().click();
    await expect(page.getByTestId(`kanban-card-${PLAIN}`)).toHaveAttribute(
      "data-column",
      "todo",
      { timeout: 30_000 },
    );
  });
}
