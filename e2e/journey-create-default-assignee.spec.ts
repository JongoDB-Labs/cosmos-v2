import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { test, expect } from "./fixtures/auth";
import type { Page } from "@playwright/test";

/**
 * E2E journey — the creator is the default assignee.
 *
 * Opening "New work item" ticks the signed-in user in Assignees; creating it
 * stores them as the assignee. Unticking yourself creates it unassigned. The
 * database is the evidence, not just the checkbox.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const PROJECT_KEY = process.env.E2E_PROJECT_KEY ?? "test"; // seeded "TEST"

const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
test.afterAll(async () => prisma.$disconnect());

async function openDialog(page: Page) {
  await page.goto(`/${ORG}/projects/${PROJECT_KEY}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Backlog" }).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "New work item" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const status = dialog.getByLabel("Status");
  await expect
    .poll(async () => (await status.locator("option").allTextContents()).length, { timeout: 20_000 })
    .toBeGreaterThan(0);
  return dialog;
}

function assigneeBoxes(dialog: ReturnType<Page["getByRole"]>) {
  return dialog.getByLabel("Search assignees").locator("xpath=..").getByRole("checkbox");
}

async function submit(dialog: ReturnType<Page["getByRole"]>, title: string) {
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel(/planned start/i).fill("2026-07-01");
  await dialog.getByLabel(/planned end/i).fill("2026-07-15");
  await dialog.getByRole("button", { name: "Create work item" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

async function assigneesOf(title: string) {
  await expect.poll(async () => prisma.workItem.count({ where: { title } }), { timeout: 15_000 }).toBe(1);
  const item = await prisma.workItem.findFirstOrThrow({
    where: { title },
    select: { assignees: { select: { user: { select: { email: true } } } } },
  });
  return item.assignees.map((a) => a.user.email);
}

test.describe("journey — creator is the default assignee", () => {
  test("the new item is assigned to whoever created it", async ({ page, signInAs }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);
    const dialog = await openDialog(page);

    const boxes = assigneeBoxes(dialog);
    await expect.poll(async () => {
      const n = await boxes.count();
      const checked: boolean[] = [];
      for (let i = 0; i < n; i++) checked.push(await boxes.nth(i).isChecked());
      return checked.filter(Boolean).length;
    }, { timeout: 15_000 }).toBe(1);

    const title = `E2E Mine ${Date.now().toString().slice(-6)}`;
    await submit(dialog, title);
    expect(await assigneesOf(title)).toEqual([EMAIL]);
  });

  test("unticking yourself creates it unassigned", async ({ page, signInAs }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);
    const dialog = await openDialog(page);

    const mine = assigneeBoxes(dialog).and(dialog.locator("input:checked"));
    await expect(mine).toHaveCount(1, { timeout: 15_000 });
    await mine.uncheck();

    const title = `E2E Nobody ${Date.now().toString().slice(-6)}`;
    await submit(dialog, title);
    expect(await assigneesOf(title)).toEqual([]);
  });
});
