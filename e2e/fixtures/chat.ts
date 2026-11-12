import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Chat lives in one place: the docked Chat drawer. There is no chat page; its
 * old address redirects into the drawer (`src/lib/chat/legacy-chat-redirect`),
 * and `?chat=<id>` on any org page opens the drawer on that conversation
 * (`src/lib/chat/drawer-link`).
 */
export function chatDrawer(page: Page): Locator {
  return page.getByRole("complementary", { name: "chat drawer" });
}

/**
 * Open the Chat drawer's conversation list on the org home, then pick #general
 * from it, the way a person does. Resolves once the conversation is on screen
 * (its "Back to channels" header replaces the list).
 *
 * `base` is "" for specs that rely on Playwright's baseURL, or the full origin
 * for specs that build absolute URLs.
 */
export async function openGeneralInDrawer(
  page: Page,
  { base = "", org = "test-org" }: { base?: string; org?: string } = {},
): Promise<Locator> {
  await page.goto(`${base}/${org}?chat=`);
  const drawer = chatDrawer(page);
  await drawer.getByRole("button", { name: "general", exact: true }).click({ timeout: 20_000 });
  await expect(drawer.getByRole("button", { name: /Back to channels/ })).toBeVisible({
    timeout: 10_000,
  });
  return drawer;
}
