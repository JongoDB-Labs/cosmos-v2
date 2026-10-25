import { test, expect } from "./fixtures/auth";
import { blocking, runAxe } from "./fixtures/axe";
import type { Page } from "@playwright/test";

/**
 * E2E journey — Project settings → Automations: create a rule from a
 * template, build one in the builder, switch one off, and open its runs.
 *
 * Runs in a project of its own (created through the API). The job runner is
 * off in e2e (JOBS_DISABLED), so no rule runs here: what a rule does is
 * src/lib/automation/engine.db.test.ts.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

async function api<T>(page: Page, url: string, init?: { method?: string; body?: unknown }) {
  return page.evaluate(
    async ({ url, init }) => {
      const res = await fetch(url, {
        method: init?.method ?? "GET",
        headers: { "Content-Type": "application/json" },
        ...(init?.body !== undefined && { body: JSON.stringify(init.body) }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { url, init },
  ) as Promise<{ status: number; body: T }>;
}

test.describe("journey — automations", () => {
  test("a template's rule, a built rule, switched off, and its runs", async ({ page, signInAs }) => {
    test.setTimeout(120_000);
    await signInAs(EMAIL);
    await page.goto(`/${ORG}`, { waitUntil: "domcontentloaded" });

    const stamp = Date.now().toString().slice(-6);
    const key = `AU${stamp}`;
    const orgs = await api<{ data?: { id: string; slug: string }[] } & { id: string; slug: string }[]>(page, "/api/v1/orgs");
    const org = ((orgs.body as { data?: { id: string; slug: string }[] }).data ?? (orgs.body as { id: string; slug: string }[])).find((o) => o.slug === ORG)!;
    const created = await api<{ id: string; data?: { id: string } }>(page, `/api/v1/orgs/${org.id}/projects`, {
      method: "POST",
      body: { name: `Automation E2E ${stamp}`, key },
    });
    expect(created.status).toBe(201);

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    // Project settings → Automations.
    await page.goto(`/${ORG}/projects/${key}/settings`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Edit automations" }).click();
    await expect(page.getByRole("heading", { name: "Automations", level: 2 })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("No automations yet")).toBeVisible({ timeout: 20_000 });

    // From a template: the parent follows its children, to the project's own Done.
    await page.getByRole("button", { name: "Start from a template" }).click();
    const picker = page.getByRole("dialog");
    await picker.getByRole("radio", { name: "Parent follows children: done" }).click();
    await picker.getByRole("button", { name: "Create rule" }).click();
    await expect(picker).toBeHidden({ timeout: 15_000 });
    const rules = page.getByRole("list", { name: "Automation rules" });
    await expect(rules.getByText("Parent follows children: done")).toBeVisible({ timeout: 15_000 });
    await expect(rules.getByText(/on its parent, if it matches .*if every child is done or cancelled: move to Done\./)).toBeVisible();

    // In the builder: label high-priority items when they're created.
    await page.getByRole("button", { name: "New rule" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Rule name").fill("Flag hot items");
    await sheet.getByLabel("Trigger").click();
    await page.getByRole("option", { name: "An item is created" }).click();
    await sheet.getByLabel("Condition query").fill("priority = HIGH");
    await sheet.getByLabel("Action 1", { exact: true }).click();
    await page.getByRole("option", { name: "Add labels" }).click();
    await sheet.getByLabel("Action 1 labels").fill("hot");
    // The builder is a form people fill in: no serious axe violations.
    expect(blocking(await runAxe(page))).toEqual([]);
    await sheet.getByRole("button", { name: "Save rule" }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });
    await expect(rules.getByText("When an item is created, if it matches priority = HIGH: add hot.")).toBeVisible({ timeout: 15_000 });

    // Switched off, and its runs (none: the job runner is off here).
    await page.getByRole("switch", { name: "Run Flag hot items" }).click();
    await expect(page.getByRole("switch", { name: "Run Flag hot items" })).toHaveAttribute("aria-checked", "false", { timeout: 15_000 });
    await rules.getByRole("listitem").filter({ hasText: "Flag hot items" }).getByRole("button", { name: "Runs" }).click();
    await expect(page.getByRole("dialog").getByText("It hasn't run yet.")).toBeVisible({ timeout: 15_000 });

    expect(errors).toEqual([]);
  });
});
