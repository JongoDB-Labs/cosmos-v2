import { test, expect } from "./fixtures/auth";
import type { Page, Locator } from "@playwright/test";

/**
 * A loaded board keeps its data when a BACKGROUND refresh fails.
 *
 * The board loads, then the project's work-items list starts answering 500.
 * Creating an item through the API fires a realtime `work-item.created` event,
 * the board refetches in the background, and that refetch fails (twice: React
 * Query retries once). The board must stay on screen with a "couldn't refresh"
 * toast, not be replaced by a full-page error with "Try again".
 *
 * Kanban runs its own fetch; Backlog runs on React Query. One case each.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const TEST_KEY = process.env.E2E_PROJECT_KEY ?? "TEST";
const GALLERY_KEY = process.env.E2E_GALLERY_PROJECT_KEY ?? "GALLERY";

const STALE_TOAST = "Couldn't refresh. Showing the last loaded data.";

/** The project's work-items LIST only — not `/work-items/:id`, not `/work-item-links`. */
const ITEMS_LIST = /\/projects\/[^/]+\/work-items(\?|$)/;

type Json = Record<string, unknown>;

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

/** `{ data: T }` or a bare `T`. */
function unwrap<T>(body: unknown): T {
  return (body && typeof body === "object" && "data" in body ? (body as { data: T }).data : body) as T;
}

/** Org id, project id and a work-item type id, read before any route is installed. */
async function ids(page: Page, projectKey: string) {
  const orgs = unwrap<{ id: string; slug: string }[]>((await api(page, "/api/v1/orgs")).body);
  const org = orgs.find((o) => o.slug === ORG)!;
  const projects = unwrap<{ id: string; key: string }[]>(
    (await api(page, `/api/v1/orgs/${org.id}/projects`)).body,
  );
  const project = projects.find((p) => p.key === projectKey)!;
  const types = unwrap<{ id: string }[]>((await api(page, `/api/v1/orgs/${org.id}/work-item-types`)).body);
  return { orgId: org.id, projectId: project.id, typeId: types[0].id };
}

async function refreshFailureKeepsBoard(
  page: Page,
  projectKey: string,
  boardPath: string,
  content: (page: Page) => Locator,
) {
  await page.goto(`/${ORG}`, { waitUntil: "domcontentloaded" });
  const { orgId, projectId, typeId } = await ids(page, projectKey);
  const base = `/api/v1/orgs/${orgId}/projects/${projectId}/work-items`;

  // The realtime stream must be open before the item is created, or the event is missed.
  const stream = page.waitForResponse((r) => /\/api\/v1\/orgs\/[^/]+\/events(\?|$)/.test(r.url()), {
    timeout: 30_000,
  });
  await page.goto(`/${ORG}/projects/${projectKey}/boards/${boardPath}`, { waitUntil: "domcontentloaded" });
  await expect(content(page)).toBeVisible({ timeout: 30_000 });
  await stream;

  const failList = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Simulated outage" }),
    });
  };
  await page.route(ITEMS_LIST, failList);

  let itemId: string | undefined;
  try {
    const created = await api<Json>(page, base, {
      method: "POST",
      body: { title: `Refresh error e2e ${Date.now()}`, workItemTypeId: typeId, columnKey: "todo" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    itemId = unwrap<{ id: string }>(created.body).id;

    // The toast appears only after the retry also failed.
    await expect(page.getByText(STALE_TOAST)).toBeVisible({ timeout: 30_000 });
    await expect(content(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);

    // The list answers again: the next refresh clears the toast.
    await page.unroute(ITEMS_LIST, failList);
    await api(page, `${base}/${itemId}`, { method: "PUT", body: { title: `Refresh error e2e (ok)` } });
    await expect(page.getByText(STALE_TOAST)).toHaveCount(0, { timeout: 30_000 });
    await expect(content(page)).toBeVisible();
  } finally {
    await page.unroute(ITEMS_LIST, failList).catch(() => {});
    if (itemId) await api(page, `${base}/${itemId}`, { method: "DELETE" });
  }
}

test.describe("board — a failed background refresh keeps the loaded board", () => {
  test("kanban keeps its columns and shows a toast", async ({ page, signInAs }) => {
    test.setTimeout(120_000);
    await signInAs(EMAIL);
    // TEST's default board is a Kanban; the project route redirects to it.
    const boardId = await (async () => {
      await page.goto(`/${ORG}`, { waitUntil: "domcontentloaded" });
      const { orgId, projectId } = await ids(page, TEST_KEY);
      const boards = unwrap<{ id: string; type: string; sortOrder: number }[]>(
        (await api(page, `/api/v1/orgs/${orgId}/projects/${projectId}/boards`)).body,
      );
      return boards.filter((b) => b.type === "KANBAN").sort((a, b) => a.sortOrder - b.sortOrder)[0].id;
    })();
    await refreshFailureKeepsBoard(page, TEST_KEY, boardId, (p) =>
      p.getByRole("heading", { name: "Backlog", exact: true }).first(),
    );
  });

  test("backlog (React Query) keeps its items and shows a toast", async ({ page, signInAs }) => {
    test.setTimeout(120_000);
    await signInAs(EMAIL);
    await refreshFailureKeepsBoard(page, GALLERY_KEY, "backlog", (p) =>
      p.getByText("Gallery item in review").first(),
    );
  });
});
