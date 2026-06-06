import { test, expect } from "./fixtures/auth";

/**
 * E2E user journey — the core "create a project" lifecycle: from the projects
 * list, run the new-project wizard (start-from-scratch → metadata), submit, and
 * verify it lands on the new project and the project shows up back in the list.
 * Exercises auth, the wizard, the create mutation, the redirect, and the list
 * refresh end to end.
 *
 * Mutating — only meaningful against an isolated DB, so it runs in the CI e2e
 * job (Postgres + test-fixtures seed). The non-mutating selector path was
 * validated locally; the create + redirect are verified here.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("journey — project lifecycle", () => {
  test("create from scratch: lands on the new project and it appears in the list", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    // Unique per run/retry so a re-run against the shared CI job DB can't 409
    // on a duplicate project key.
    const suffix = Date.now().toString().slice(-6);
    const name = `E2E Journey ${suffix}`;
    const key = `E2E${suffix}`; // e.g. E2E123456 — matches ^[A-Z][A-Z0-9]*$, ≤10 chars

    await page.goto(`/${ORG}/projects`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });

    // Entry: the header "New project" link, or the empty-state "Create project"
    // CTA (a brand-new org shows the latter).
    await page
      .getByRole("link", { name: /new project/i })
      .or(page.getByRole("button", { name: /create project/i }))
      .first()
      .click();
    await page.waitForURL(/\/projects\/new/, { timeout: 15_000 });

    // Step 1: skip sector/template.
    await page
      .getByRole("button", { name: /start from scratch/i })
      .first()
      .click();

    // Step 3: metadata. Gate on a single instance — the page transition briefly
    // double-renders during its enter animation.
    const nameInput = page.getByLabel(/^Project name/i);
    await expect(nameInput).toHaveCount(1, { timeout: 15_000 });
    await nameInput.fill(name);
    // Override the key auto-derived from the name with our unique one.
    await page.getByLabel(/^Project key/i).fill(key);

    await page.getByRole("button", { name: /create project/i }).click();

    // Success: redirect to the new project, and its title heading renders.
    await expect(page).toHaveURL(
      new RegExp(`/${ORG}/projects/${key.toLowerCase()}`),
      { timeout: 25_000 },
    );
    await expect(page.getByRole("heading", { name }).first()).toBeVisible({
      timeout: 20_000,
    });

    // The project is reachable directly by its key (the canonical post-create
    // landing), confirming it was persisted.
    await page.goto(`/${ORG}/projects/${key.toLowerCase()}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("main", { timeout: 20_000 });
    await expect(page.getByRole("heading", { name }).first()).toBeVisible({
      timeout: 20_000,
    });
    // The new project now appears in the /projects LIST: the create POST hard-
    // expires the `org:<id>:projects` cache tag (revalidateTag(tag,{expire:0})),
    // so this fresh navigation is a cache miss and re-queries the DB. (ProjectCard
    // renders a <Link> whose accessible name contains the project name.)
    await page.goto(`/${ORG}/projects`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });
    await expect(
      page.getByRole("link", { name: new RegExp(name) }).first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});
