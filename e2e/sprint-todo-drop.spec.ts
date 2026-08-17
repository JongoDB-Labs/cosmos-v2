// Reproduction attempt on a SCRUM (Sprint) board — the surface the report came
// from. Earlier attempts used a KANBAN board, which is the same component but
// NOT scoped to an interval.
import { test, expect } from "./fixtures/auth";
import type { Page } from "@playwright/test";

const BOARD = process.env.SCRUM_BOARD_ID ?? "";
const FROM_BACKLOG = process.env.FROM_BACKLOG ?? "";
const FROM_DONE = process.env.FROM_DONE ?? "";
const FROM_IP = process.env.FROM_IP ?? "";

test.skip(!BOARD, "needs the scrum-repro fixture ids");

async function openBoard(page: Page) {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto(`/test-org/projects/TEST/boards/${BOARD}`, { waitUntil: "domcontentloaded" });
  const clear = page.getByRole("button", { name: /^clear$/i });
  if (await clear.count()) await clear.first().click();
  await expect(page.getByTestId("kanban-column-todo")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
}

/** Put a card in a known column via the API, so a re-run starts from a clean
 *  state. These specs share a database and are otherwise NOT idempotent: after
 *  one pass every card already sits in To Do and the test would assert nothing. */
async function parkInColumn(page: Page, itemId: string, columnKey: string) {
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
}

async function dragCardTo(page: Page, cardId: string, columnKey: string) {
  const card = page.getByTestId(`kanban-card-${cardId}`);
  const col = page.getByTestId(`kanban-column-${columnKey}`);
  await expect(card).toBeVisible();
  const from = (await card.boundingBox())!;
  const to = (await col.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(200);
  const tx = Math.min(Math.max(to.x + to.width / 2, 5), 1495);
  const ty = to.y + 60;
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(
      from.x + from.width / 2 + ((tx - from.x - from.width / 2) * i) / 20,
      from.y + 20 + ((ty - from.y - 20) * i) / 20,
    );
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(1500);
}

for (const [label, id, columnKey] of [
  ["Backlog", FROM_BACKLOG, "backlog"],
  ["In Progress", FROM_IP, "in-progress"],
  ["Done", FROM_DONE, "done"],
] as const) {
  test(`SPRINT board: ${label} -> To Do`, async ({ page, signInAs }) => {
    test.setTimeout(120_000);
    await signInAs("alice@test.local");
    await openBoard(page);

    // Re-runnable: put the card back where this case needs it to start.
    await parkInColumn(page, id, columnKey);
    await page.reload({ waitUntil: "domcontentloaded" });
    const c0 = page.getByRole("button", { name: /^clear$/i });
    if (await c0.count()) await c0.first().click();
    await expect(page.getByTestId(`kanban-card-${id}`)).toHaveAttribute(
      "data-column",
      columnKey,
      { timeout: 20_000 },
    );

    // Rule out the harness artifact: if the source card sits outside the
    // viewport the synthetic grab clamps at the edge and never lands on it.
    const card0 = page.getByTestId(`kanban-card-${id}`);
    await card0.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const box = await card0.boundingBox();
    const vp = page.viewportSize()!;
    expect(
      !!box && box.x >= 0 && box.x + box.width <= vp.width,
      `${label} card must be fully on screen before the drag, or the synthetic ` +
        `pointer clamps at the viewport edge and the HARNESS fails, not the product`,
    ).toBe(true);
    const before = await card0.getAttribute("data-column");
    await dragCardTo(page, id, "todo");
    for (const n of [/leave the parent/i, /keep today/i]) {
      const b = page.getByRole("button", { name: n });
      if (await b.count()) await b.first().click({ timeout: 2500 }).catch(() => {});
    }
    const after = await page.getByTestId(`kanban-card-${id}`).getAttribute("data-column");
    expect(before, `${label} card should have started in its own column`).not.toBe("todo");
    await page.screenshot({ path: `/tmp/sprint-${label.replace(/\s/g, "")}.png` });
    expect(after).toBe("todo");
  });
}
