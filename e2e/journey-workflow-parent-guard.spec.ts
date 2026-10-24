import { test, expect } from "./fixtures/auth";
import type { Page } from "@playwright/test";

/**
 * E2E journey — the workflow's parent guard holds in the detail panel, not
 * only on a board drag.
 *
 * The board has always refused to drop a parent on Done over open sub-items,
 * but only on the board: the detail panel's Status menu, bulk edits and the
 * API went straight through. The guard is the server's now. This seeds a
 * parent with one open child through the API, opens the parent, picks Done in
 * the Status menu, and expects the server's refusal, named and with the
 * status put back. Then it finishes the child and the same move goes through.
 *
 * Needs the seeded "TEST" project (default statuses). Unique titles per run.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const PROJECT_KEY = process.env.E2E_PROJECT_KEY ?? "test";

/** Create an item through the API, in the browser's own session. */
async function createItem(page: Page, title: string, extra: Record<string, unknown> = {}) {
  return page.evaluate(
    async ({ title, extra }) => {
      const j = async (u: string) => (await (await fetch(u)).json());
      const orgs = await j("/api/v1/orgs");
      const org = (orgs.data ?? orgs).find((o: { slug: string }) => o.slug === "test-org");
      const projects = await j(`/api/v1/orgs/${org.id}/projects`);
      const project = (projects.data ?? projects).find((p: { key: string }) => p.key === "TEST");
      const types = await j(`/api/v1/orgs/${org.id}/work-item-types`);
      const type = (types.data ?? types)[0];
      const res = await fetch(`/api/v1/orgs/${org.id}/projects/${project.id}/work-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, workItemTypeId: type.id, columnKey: "todo", ...extra }),
      });
      const item = await res.json();
      return { id: (item.data ?? item).id as string, base: `/api/v1/orgs/${org.id}/projects/${project.id}/work-items` };
    },
    { title, extra },
  );
}

async function pickStatus(page: Page, name: string) {
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

test.describe("journey — workflow parent guard", () => {
  test("the detail panel can't finish a parent over an open sub-item", async ({ page, signInAs }) => {
    test.setTimeout(90_000);
    await signInAs(EMAIL);
    await page.goto(`/${ORG}/projects/${PROJECT_KEY}`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/boards\/[0-9a-f-]{36}$/i, { timeout: 20_000 }).catch(() => {});
    await page.waitForSelector("main", { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Backlog" }).first()).toBeVisible({ timeout: 20_000 });

    const stamp = Date.now().toString().slice(-6);
    const parent = await createItem(page, `E2E Guard parent ${stamp}`);
    const child = await createItem(page, `E2E Guard child ${stamp}`, { parentId: parent.id });

    // Open the parent from the board.
    await page.reload({ waitUntil: "domcontentloaded" });
    const card = page.getByText(`E2E Guard parent ${stamp}`).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });

    await pickStatus(page, "Done");
    await expect(page.getByText(new RegExp(`Finish its sub-items first: E2E Guard child ${stamp}`)).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("dialog").getByRole("combobox", { name: "Status" })).toHaveText(/To Do/);

    // Finish the child; now the parent may close.
    await page.evaluate(
      async ({ url }) => {
        await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ columnKey: "done" }) });
      },
      { url: `${child.base}/${child.id}` },
    );
    await pickStatus(page, "Done");
    await expect(page.getByRole("dialog").getByRole("combobox", { name: "Status" })).toHaveText(/Done/, { timeout: 15_000 });

    // Leave nothing behind.
    await page.evaluate(
      async ({ urls }) => {
        for (const u of urls) await fetch(u, { method: "DELETE" });
      },
      { urls: [`${child.base}/${child.id}`, `${parent.base}/${parent.id}`] },
    );
  });
});
