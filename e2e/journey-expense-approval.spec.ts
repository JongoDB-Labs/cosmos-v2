import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — expense approval workflow. Create an expense (DRAFT), submit it
 * for approval (SUBMITTED), then approve one (APPROVED), asserting the status
 * badge at each step. Validates the status column, the submit + approve
 * routes, and the finance-dashboard UI end to end.
 *
 * WHO APPROVES WHAT. alice is ADMIN → FINANCE_MANAGE (create/submit her own)
 * and EXPENSE_APPROVE. But the seed gives her a supervisor (bob), and approval
 * follows the one rule timesheets use: you don't approve your OWN expense
 * while somebody supervises you. So this asserts both halves:
 *   - her own submitted expense is refused, with the reason, and stays Submitted;
 *   - an expense somebody else submitted, she approves.
 * bob is a MEMBER with no FINANCE_MANAGE, so his expense is written straight to
 * the database rather than through a form he cannot open.
 *
 * Mutating — CI e2e job (Postgres + seed). Rows are found by a unique category,
 * so earlier runs' expenses on the same database don't confuse the menus.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const SUBMITTER = "bob@test.local";

const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("journey — expense approval", () => {
  test("create → submit → approve an expense", async ({ page, signInAs }) => {
    test.setTimeout(90_000);

    const stamp = Date.now().toString().slice(-6);
    const mine = `E2E Exp ${stamp}`;
    const theirs = `E2E Exp bob ${stamp}`;

    const org = await prisma.organization.findUnique({ where: { slug: ORG }, select: { id: true } });
    const bob = await prisma.user.findFirst({ where: { email: SUBMITTER }, select: { id: true } });
    if (!org || !bob) throw new Error("seed missing: test org or bob");
    await prisma.expense.create({
      data: {
        orgId: org.id, amount: 18.25, date: new Date(), category: theirs,
        status: "SUBMITTED", submittedAt: new Date(), createdById: bob.id,
      },
    });

    await signInAs(EMAIL);
    await page.goto(`/${ORG}/accounting/finance`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });

    // Switch to the Expenses tab and open the create dialog.
    await page.getByRole("button", { name: /^Expenses$/i }).first().click();
    await page.getByRole("button", { name: /add expense/i }).first().click();
    await expect(page.getByRole("heading", { name: /add expense/i })).toBeVisible({
      timeout: 10_000,
    });

    // Amount + a unique category (date defaults to today; Save needs both).
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^Amount$/i).fill("42.50");
    await dialog.getByLabel(/^Category$/i).fill(mine);
    await dialog.getByRole("button", { name: /^Save$/ }).click();

    const row = (category: string) => page.getByRole("row").filter({ hasText: category });
    const openMenu = (category: string) => row(category).getByRole("button", { name: "Open menu" }).click();

    // Created as DRAFT.
    await expect(row(mine)).toBeVisible({ timeout: 20_000 });
    await expect(row(mine).getByText("Draft")).toBeVisible({ timeout: 10_000 });

    // Submit for approval → SUBMITTED.
    await openMenu(mine);
    await page.getByRole("menuitem", { name: /submit for approval/i }).click();
    await expect(row(mine).getByText("Submitted")).toBeVisible({ timeout: 15_000 });

    // Her own: refused, with the reason, and still waiting.
    await openMenu(mine);
    await page.getByRole("menuitem", { name: /^Approve$/i }).click();
    await expect(page.getByText(/approved by your supervisor/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(row(mine).getByText("Submitted")).toBeVisible();

    // Somebody else's → APPROVED.
    await expect(row(theirs).getByText("Submitted")).toBeVisible({ timeout: 15_000 });
    await openMenu(theirs);
    await page.getByRole("menuitem", { name: /^Approve$/i }).click();
    await expect(row(theirs).getByText("Approved")).toBeVisible({ timeout: 15_000 });
  });
});
