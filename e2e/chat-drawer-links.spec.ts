import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures/auth";
import { chatDrawer } from "./fixtures/chat";
import { getTestUserId } from "./fixtures/users";

/**
 * Chat is one surface, the docked drawer. Everything that used to open the chat
 * page now opens the drawer beside the page you are on: the old addresses
 * redirect there, `?chat=<id>` opens it from any page, and a notification, a
 * "Mentioned in" backlink and a new DM open it in place without navigating.
 */
const ORG = "test-org";

async function json<T>(r: Awaited<ReturnType<APIRequestContext["get"]>>, what: string): Promise<T> {
  if (!r.ok()) throw new Error(`${what}: ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

async function orgIdOf(request: APIRequestContext): Promise<string> {
  const j = await json<{ data?: Array<{ id: string; slug: string }> } | Array<{ id: string; slug: string }>>(
    await request.get("/api/v1/orgs"),
    "GET /api/v1/orgs",
  );
  const org = (Array.isArray(j) ? j : (j.data ?? [])).find((o) => o.slug === ORG);
  if (!org) throw new Error(`org "${ORG}" not found`);
  return org.id;
}

async function generalIdOf(request: APIRequestContext, orgId: string): Promise<string> {
  const j = await json<{ channels: Array<{ id: string; kind: string; name: string | null }> }>(
    await request.get(`/api/v1/orgs/${orgId}/chat/channels`),
    "GET chat channels",
  );
  const general = j.channels.find((c) => c.kind === "CHANNEL" && c.name === "general");
  if (!general) throw new Error("#general not found");
  return general.id;
}

/** Post a message to a channel as whoever `request` is signed in as. */
async function post(
  request: APIRequestContext,
  baseURL: string,
  orgId: string,
  channelId: string,
  content: string,
): Promise<string> {
  const id = randomUUID();
  const r = await request.post(`/api/v1/orgs/${orgId}/chat/channels/${channelId}/messages`, {
    data: { id, content },
    headers: { Origin: baseURL },
  });
  if (!r.ok()) throw new Error(`post message: ${r.status()} ${await r.text()}`);
  return id;
}

/** The drawer shows #general's conversation: its header and its composer. */
async function expectGeneralOpen(page: Page) {
  const drawer = chatDrawer(page);
  await expect(drawer.getByRole("button", { name: "Back to channels" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(drawer.getByPlaceholder(/^Message general/i)).toBeVisible();
  return drawer;
}

const path = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;

test.describe("chat opens in the drawer, from every link", () => {
  test("the old conversation address redirects into the drawer on that conversation", async ({
    page,
    signInAs,
  }) => {
    await signInAs("alice@test.local");
    const orgId = await orgIdOf(page.request);
    const generalId = await generalIdOf(page.request, orgId);

    // The redirect itself: temporary, to the org home, naming the conversation.
    const res = await page.request.get(`/${ORG}/chat/${generalId}`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    const to = new URL(res.headers()["location"]!, "http://placeholder");
    expect(to.pathname).toBe(`/${ORG}`);
    expect(to.searchParams.get("chat")).toBe(generalId);

    // In the browser: the drawer opens on #general and the address is clean.
    await page.goto(`/${ORG}/chat/${generalId}`);
    await expectGeneralOpen(page);
    await expect.poll(() => path(page)).toBe(`/${ORG}`);
  });

  test("the old chat landing page opens the drawer's conversation list", async ({
    page,
    signInAs,
  }) => {
    await signInAs("alice@test.local");
    await page.goto(`/${ORG}/chat`);
    await expect(
      chatDrawer(page).getByRole("button", { name: "general", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => path(page)).toBe(`/${ORG}`);
  });

  test("an old link followed from a page comes back to that page", async ({ page, signInAs }) => {
    await signInAs("alice@test.local");
    const orgId = await orgIdOf(page.request);
    const generalId = await generalIdOf(page.request, orgId);

    await page.goto(`/${ORG}/projects`);
    await page.waitForSelector("main", { timeout: 20_000 });
    await expect(chatDrawer(page)).toHaveCount(0);
    // A full navigation, as a bookmark or a pasted link is: the browser names
    // this page in the Referer, and the redirect returns to it.
    await page.evaluate((href) => window.location.assign(href), `/${ORG}/chat/${generalId}`);
    await expectGeneralOpen(page);
    await expect.poll(() => path(page)).toBe(`/${ORG}/projects`);
  });

  test("?chat=<id> on any page opens the drawer on that conversation", async ({
    page,
    signInAs,
  }) => {
    await signInAs("alice@test.local");
    const orgId = await orgIdOf(page.request);
    const generalId = await generalIdOf(page.request, orgId);

    await page.goto(`/${ORG}/work-items?chat=${generalId}`);
    await expectGeneralOpen(page);
    // The page keeps its address; the chat parameter is gone once read.
    await expect.poll(() => path(page)).toBe(`/${ORG}/work-items`);

    // Control: the same page without the parameter leaves chat shut.
    await page.goto(`/${ORG}/work-items`);
    await page.waitForSelector("main", { timeout: 20_000 });
    await expect(chatDrawer(page)).toHaveCount(0);
  });

  test("+ New DM starts the conversation in the drawer, without leaving the page", async ({
    page,
    signInAs,
  }) => {
    await signInAs("alice@test.local");
    await page.goto(`/${ORG}/projects?chat=`);
    const drawer = chatDrawer(page);
    await drawer.getByRole("button", { name: "+ New DM" }).click({ timeout: 20_000 });

    const dialog = page.getByRole("dialog", { name: "New direct message" });
    await dialog.getByPlaceholder("Add people…").fill("Bob");
    await dialog.getByRole("button", { name: /bob@test\.local/ }).click();
    await dialog.getByRole("button", { name: "Start" }).click();

    await expect(dialog).toBeHidden();
    await expect(drawer.getByRole("button", { name: "Back to channels" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(drawer.getByPlaceholder(/^Message Bob/)).toBeVisible();
    await expect.poll(() => path(page)).toBe(`/${ORG}/projects`);
  });

  test("a mention notification opens the drawer at that message, beside the page", async ({
    page,
    signInAs,
    request,
    baseURL,
  }) => {
    const base = baseURL ?? "http://localhost:3000";
    // Alice, in her own session, mentions Bob in #general.
    const signIn = await request.post("/api/testenv/sign-in", {
      data: { email: "alice@test.local" },
      headers: { Origin: base },
    });
    expect(signIn.ok()).toBe(true);
    const orgId = await orgIdOf(request);
    const generalId = await generalIdOf(request, orgId);
    const bobId = await getTestUserId(request, base, "bob@test.local");
    const stamp = `bell-${Date.now().toString(36)}`;
    const messageId = await post(request, base, orgId, generalId, `Ping ${stamp} <@${bobId}>`);

    await signInAs("bob@test.local");
    // The notification names the drawer, not a chat page.
    await expect
      .poll(async () => {
        const list = await json<Array<{ body: string | null; url: string | null }>>(
          await page.request.get(`/api/v1/orgs/${orgId}/notifications`),
          "GET notifications",
        );
        return list.find((n) => n.body?.includes(stamp))?.url ?? null;
      })
      .toBe(`/${ORG}?chat=${generalId}&chatMsg=${messageId}`);

    await page.goto(`/${ORG}/projects`);
    await page.waitForSelector("main", { timeout: 20_000 });
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const panel = page.getByRole("dialog", { name: "Notifications" });
    await panel.getByRole("button", { name: new RegExp(stamp) }).click({ timeout: 20_000 });

    const drawer = await expectGeneralOpen(page);
    await expect(drawer.getByText(new RegExp(`Ping ${stamp}`))).toBeVisible();
    // Opened in place: the page behind did not change.
    await expect.poll(() => path(page)).toBe(`/${ORG}/projects`);
  });

  test("a chat message in 'Mentioned in' opens the drawer at that message", async ({
    page,
    signInAs,
    baseURL,
  }) => {
    const base = baseURL ?? "http://localhost:3000";
    await signInAs("alice@test.local");
    const orgId = await orgIdOf(page.request);
    const generalId = await generalIdOf(page.request, orgId);
    const projects = await json<Array<{ id: string; key: string }> | { data: Array<{ id: string; key: string }> }>(
      await page.request.get(`/api/v1/orgs/${orgId}/projects`),
      "GET projects",
    );
    const fal = (Array.isArray(projects) ? projects : projects.data).find((p) => p.key === "FAL");
    if (!fal) throw new Error("project FAL not found (the e2e seed's fixtures)");
    const stamp = `backlink-${Date.now().toString(36)}`;
    const messageId = await post(
      page.request,
      base,
      orgId,
      generalId,
      `Backlink ${stamp} <@project:${fal.id}>`,
    );

    await page.goto(`/${ORG}/projects/FAL/settings`);
    // This message's backlink, picked by the message it names.
    const link = page.locator(`a[href*="chatMsg=${messageId}"]`);
    await expect(link).toHaveText(/Message · #general/, { timeout: 20_000 });
    await expect(link).toHaveAttribute("href", new RegExp(`[?&]chat=${generalId}`));
    await link.click();

    const drawer = await expectGeneralOpen(page);
    await expect(drawer.getByText(new RegExp(`Backlink ${stamp}`))).toBeVisible();
    await expect.poll(() => path(page)).toBe(`/${ORG}/projects/FAL/settings`);
  });
});
