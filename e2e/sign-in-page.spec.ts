import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { test, expect, type Page } from "@playwright/test";
import { hashPassword } from "../src/lib/auth/password";
import { runAxe } from "./fixtures/axe";

/**
 * The sign-in page, signed out:
 * - a page opened signed out is where signing in lands;
 * - the forgot-password form says so when no link was sent;
 * - the error banner is readable in light and dark.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";

const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// A user of its own, so no seeded account changes. A fresh address each run
// keeps a second run on the same database from colliding with the first.
const stamp = Date.now();
const EMAIL = `return-${stamp}@test.local`;
const PASSWORD = `Return-${stamp}-pw!`;

test.beforeAll(async () => {
  const org = await prisma.organization.findUnique({ where: { slug: ORG }, select: { id: true } });
  if (!org) throw new Error(`seed missing: org "${ORG}" not found`);
  const user = await prisma.user.create({
    data: { email: EMAIL, displayName: "Return Tester", passwordHash: hashPassword(PASSWORD), passwordSetAt: new Date() },
  });
  await prisma.orgMember.create({ data: { orgId: org.id, userId: user.id, role: "MEMBER" } });
});

test.afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.$disconnect();
});

/** Opens the email and password form. A click before the page hydrates does nothing, so it retries. */
async function openPasswordForm(page: Page) {
  const open = page.getByRole("button", { name: /email & password/i });
  await expect(async () => {
    if (await open.isVisible()) await open.click();
    await expect(page.getByPlaceholder("you@company.com").first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

test("a page opened signed out is where signing in lands", async ({ page }) => {
  test.setTimeout(60_000);
  const deepLink = `/${ORG}/projects?view=list`;
  await page.goto(deepLink);
  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get("next")).toBe(deepLink);

  await openPasswordForm(page);
  await page.getByPlaceholder("you@company.com").first().fill(EMAIL);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.pathname}${url.search}`;
    }, { timeout: 30_000 })
    .toBe(deepLink);
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 20_000 });
});

test("the forgot-password form says so when no link was sent", async ({ page }) => {
  await page.route("**/api/auth/password/reset/request", (route) => route.fulfill({ status: 500, body: "{}" }));
  await page.goto("/login");
  await openPasswordForm(page);
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByPlaceholder("you@company.com").first().fill("nobody@test.local");
  await page.getByRole("button", { name: "Send reset link" }).click();

  // Next keeps an empty route announcer with role "alert" on every page.
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveText(
    "We couldn't send a reset link. Try again in a minute.",
  );
  // Still on the form, so the visitor can try again.
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the sign-in error banner is readable (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/login?error=auth_failed");
    await expect(page.getByText("Sign-in failed. Please try again.")).toBeVisible();

    const violations = await runAxe(page);
    expect(violations.filter((v) => v.id === "color-contrast")).toEqual([]);

    // Positive control: axe measured the banner and passed it, rather than
    // skipping it (a background it can't work out lands in "incomplete").
    const banner = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{
        passes: { nodes: { html: string }[] }[];
      }> } }).axe;
      const result = await axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] } });
      return result.passes.flatMap((rule) => rule.nodes).filter((node) => node.html.includes("Sign-in failed")).length;
    });
    expect(banner).toBe(1);
  });
}
