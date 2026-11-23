import { test, expect } from "./fixtures/auth";
import { createIssueFromBoard } from "./fixtures/create-issue";

/**
 * E2E journey — create a card on a SLOW Kanban board, loaded a while ago.
 *
 * journey-create-work-item.spec.ts creates on a freshly loaded, fast board, so
 * the post-create refresh is answered from the 30s cache and finishes long
 * before the realtime `work-item.created` refresh starts. That hid a bug: on a
 * board loaded more than 30s earlier whose item list takes longer than the
 * ~400ms realtime debounce to answer, the realtime refresh overtook the
 * board's own refresh and the loading skeleton never cleared — the card only
 * appeared after a hard refresh.
 *
 * This spec reproduces those conditions: it moves the page clock past the 30s
 * staleTime and delays the item-list GET.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const PROJECT_KEY = process.env.E2E_PROJECT_KEY ?? "test"; // seeded "TEST"

test.describe("journey — create on a slow Kanban board", () => {
  test("the new card appears without a refresh", async ({ page, signInAs }) => {
    test.setTimeout(90_000);
    await page.clock.install();
    await signInAs(EMAIL);

    const title = `E2E Slow ${Date.now().toString().slice(-6)}`;

    await page.goto(`/${ORG}/projects/${PROJECT_KEY}`, { waitUntil: "domcontentloaded" });
    await page
      .waitForURL(/\/projects\/[^/]+\/boards\/[0-9a-f-]{36}$/i, { timeout: 20_000 })
      .catch(() => {});
    await expect(page.getByRole("heading", { name: "Backlog" }).first()).toBeVisible({
      timeout: 20_000,
    });

    // The board was loaded "a while ago": past the 30s staleTime.
    await page.clock.fastForward(31_000);

    // A slow item list: every GET of the project's work items takes 1.5s,
    // well past the 400ms realtime debounce.
    await page.route(/\/api\/v1\/orgs\/[^/]+\/projects\/[^/]+\/work-items(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        await new Promise((r) => setTimeout(r, 1_500));
      }
      await route.continue();
    });

    await createIssueFromBoard(page, title, "Backlog");

    // With the bug, the skeleton replaced the columns and never cleared.
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Backlog" }).first()).toBeVisible();
  });
});
