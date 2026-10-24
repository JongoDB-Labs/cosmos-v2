import { test, expect } from "./fixtures/auth";
import { blocking, runAxe } from "./fixtures/axe";
import type { Page } from "@playwright/test";

/**
 * E2E journey — build a workflow in the editor, publish it, put the project on
 * it, and see the server hold the move it no longer allows.
 *
 * Runs in a project of its own (created through the API), so assigning a
 * workflow never touches the seeded TEST project other specs share.
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

test.describe("journey — workflow editor", () => {
  test("untick a move, publish, assign: the server refuses that move", async ({ page, signInAs }) => {
    test.setTimeout(120_000);
    await signInAs(EMAIL);
    await page.goto(`/${ORG}`, { waitUntil: "domcontentloaded" });

    const stamp = Date.now().toString().slice(-6);
    const key = `WF${stamp}`;
    const orgs = await api<{ data?: { id: string; slug: string }[] } & { id: string; slug: string }[]>(page, "/api/v1/orgs");
    const org = ((orgs.body as { data?: { id: string; slug: string }[] }).data ?? (orgs.body as { id: string; slug: string }[])).find((o) => o.slug === ORG)!;
    const created = await api<{ id: string; data?: { id: string } }>(page, `/api/v1/orgs/${org.id}/projects`, {
      method: "POST",
      body: { name: `Workflow E2E ${stamp}`, key },
    });
    expect(created.status).toBe(201);
    const projectId = created.body.data?.id ?? created.body.id;

    // Project settings → Workflows.
    await page.goto(`/${ORG}/projects/${key}/settings`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Edit workflows" }).click();
    await expect(page.getByRole("heading", { name: "Workflows", level: 2 })).toBeVisible({ timeout: 20_000 });

    // A new workflow, from the open one.
    await page.getByRole("button", { name: "New workflow" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Strict flow");
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await page.waitForURL(/\/settings\/workflows\/[0-9a-f-]{36}$/i, { timeout: 20_000 });

    // In the matrix, Done no longer goes back to To Do.
    const cell = page.getByRole("checkbox", { name: "Move from Done to To Do" });
    await expect(cell).toBeChecked({ timeout: 20_000 });
    // The matrix is the editor's accessible view: no serious axe violations.
    expect(blocking(await runAxe(page))).toEqual([]);
    await cell.uncheck();
    await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible({ timeout: 15_000 });

    // The diagram shows the same draft: every status, the "any" node, laid out in bands.
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && /layout/i.test(m.text()) && errors.push(m.text()));
    await page.getByRole("tab", { name: "Diagram" }).click();
    const diagram = page.getByRole("region", { name: /Workflow diagram/ });
    await expect(diagram.locator(".react-flow__node")).toHaveCount(7, { timeout: 20_000 });
    await expect(diagram.getByTestId("rf__node-in-progress")).toContainText("In Progress");
    // Laid out: the nodes are not all stacked at the origin.
    await expect
      .poll(async () => new Set(await diagram.locator(".react-flow__node").evaluateAll((els) => els.map((e) => (e as HTMLElement).style.transform))).size, { timeout: 20_000 })
      .toBeGreaterThan(1);
    expect(errors).toEqual([]);
    await page.getByRole("tab", { name: "Transitions" }).click();

    await page.getByRole("button", { name: "Publish…" }).click();
    const publish = page.getByRole("dialog");
    await expect(publish.getByRole("heading", { name: /Publish version 1/ })).toBeVisible({ timeout: 15_000 });
    await publish.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Published version 1.")).toBeVisible({ timeout: 15_000 });

    // Put the project on it.
    await page.getByRole("link", { name: "Workflows" }).click();
    await page.getByRole("combobox", { name: "Workflow for Project default" }).click();
    await page.getByRole("option", { name: "Strict flow" }).click();
    await expect(page.getByText("Workflow assigned.")).toBeVisible({ timeout: 15_000 });

    // The server now holds it: Done → To Do is refused, Done → In Progress is not.
    const types = await api<{ id: string }[] | { data: { id: string }[] }>(page, `/api/v1/orgs/${org.id}/work-item-types`);
    const typeId = (Array.isArray(types.body) ? types.body : types.body.data)[0].id;
    const base = `/api/v1/orgs/${org.id}/projects/${projectId}/work-items`;
    const item = await api<{ id: string; data?: { id: string } }>(page, base, {
      method: "POST",
      body: { title: `E2E strict ${stamp}`, workItemTypeId: typeId, columnKey: "done" },
    });
    const itemId = item.body.data?.id ?? item.body.id;
    const refused = await api<{ code: string }>(page, `${base}/${itemId}`, { method: "PUT", body: { columnKey: "todo" } });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("transition_not_allowed");
    const allowed = await api(page, `${base}/${itemId}`, { method: "PUT", body: { columnKey: "in-progress" } });
    expect(allowed.status).toBe(200);
  });
});
