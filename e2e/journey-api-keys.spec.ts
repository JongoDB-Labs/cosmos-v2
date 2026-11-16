import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures/auth";
import { blocking, runAxe } from "./fixtures/axe";

/**
 * E2E journey — API keys, and the switch that lets members make them.
 *
 * 1. alice (ADMIN) creates a key on Settings → API keys, sees it listed, uses
 *    it, and revokes it: it leaves both lists, its row leaves the database, and
 *    it stops authenticating.
 * 2. alice turns off "Members can create their own API keys" on Settings →
 *    Security, and bob (MEMBER) sees his API keys page change: no Create key,
 *    and the sentence saying why. His page is checked with the switch on first,
 *    so its absence afterwards means something.
 *
 * THE KEY IS NEVER PRINTED. It is read once into a variable and only ever
 * compared by shape, as a boolean. No assertion targets the element that shows
 * it (a failing locator prints the element's text), and the screenshot of its
 * dialog masks it.
 *
 * SHARED STATE. The org and its users are shared with every other spec, and
 * the security settings row is the org's. Test 2 snapshots that row and puts it
 * back in a `finally`, through the database, so a failed save or a dead page
 * still restores it. Keys are named per run, and afterAll deletes any this file
 * named (a run that died between create and revoke).
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const ADMIN = process.env.E2E_EMAIL ?? "alice@test.local";
const MEMBER = "bob@test.local";
const KEY_PREFIX = "E2E key";
const MEMBER_SWITCH = "Members can create their own API keys";
const MEMBER_KEYS_OFF =
  "An admin has turned off API keys for members, so you can't create keys and your existing keys don't work.";

const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

test.afterAll(async () => {
  await prisma.apiKey.deleteMany({ where: { name: { startsWith: KEY_PREFIX } } });
  await prisma.$disconnect();
});

async function orgId(): Promise<string> {
  const org = await prisma.organization.findUnique({ where: { slug: ORG }, select: { id: true } });
  if (!org) throw new Error(`seed missing: org "${ORG}"`);
  return org.id;
}

/** A screenshot beside the test's other output, for a person to look at. */
async function snap(page: Page, name: string, mask: Locator[] = []) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), mask, fullPage: true });
}

async function openApiKeys(page: Page) {
  await page.goto(`/${ORG}/settings/api-keys`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("region", { name: "Your API keys" })).toBeVisible({ timeout: 30_000 });
}

test.describe("journey — API keys", () => {
  test("an admin creates a key, sees it listed, and revokes it", async ({ page, signInAs, request }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const id = await orgId();
    const name = `${KEY_PREFIX} ${Date.now().toString().slice(-6)}`;

    await signInAs(ADMIN);
    await openApiKeys(page);
    const own = page.getByRole("region", { name: "Your API keys" });
    const all = page.getByRole("region", { name: "All keys in this organization" });

    // The button is server-rendered before React hydrates it: re-click until the dialog opens.
    const create = page.getByRole("dialog", { name: "Create API key" });
    await expect(async () => {
      await own.getByRole("button", { name: "Create key" }).click();
      await expect(create).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await create.getByLabel("Name").fill(name);
    const read = create.getByRole("checkbox", { name: "Read read", exact: true });
    await read.check();
    // A form people fill in: no serious axe violations, with a scope ticked.
    // A ticked scope's `code` label is the smallest muted text on the darkest
    // ground in the dialog (10px, on the ticked row's tint). It was 4.29:1
    // with #64748b; the default skin's muted text is darker now (#5B697E).
    // The row fades its background in, so the scan waits for that transition
    // to end: mid-fade, axe would measure a lighter ground and pass early.
    const row = create.locator("label").filter({ has: read });
    await expect.poll(() => row.evaluate((el) => el.getAnimations().length), { timeout: 5_000 }).toBe(0);
    // Positive control: the row really is tinted, so the scan sees the ticked state.
    expect(await row.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    expect(blocking(await runAxe(page))).toEqual([]);

    const minted = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith(`/api/v1/orgs/${id}/api-keys`),
    );
    await create.getByRole("button", { name: "Create", exact: true }).click();
    expect((await minted).status()).toBe(201);

    const shown = page.getByRole("dialog", { name: "API key created" });
    await expect(shown.getByText("Copy this now — it will not be shown again.")).toBeVisible({ timeout: 15_000 });
    const tokenBox = shown.locator("code");
    const token = (await tokenBox.textContent())?.trim() ?? "";
    expect(token.startsWith("cosmos_") && token.length > 20, "the dialog shows a cosmos_ token").toBe(true);
    await snap(page, "1-key-created", [tokenBox]);

    // It works: a request carrying only the key (no session cookie) is let in.
    const asKey = { headers: { Authorization: `Bearer ${token}` } };
    expect((await request.get(`/api/v1/orgs/${id}/projects`, asKey)).status(), "the new key authenticates").toBe(200);

    await shown.getByRole("button", { name: "Done" }).click();
    await expect(shown).toBeHidden();

    // Listed under the admin's own keys and under every key in the org, with its scope.
    for (const list of [own, all]) {
      await expect(list.getByRole("button", { name: `Revoke ${name}`, exact: true })).toBeVisible({ timeout: 15_000 });
    }
    await expect(all.getByText("Made by Alice").first()).toBeVisible();
    await snap(page, "2-key-listed");

    await own.getByRole("button", { name: `Revoke ${name}`, exact: true }).click();
    const revoke = page.getByRole("dialog", { name: "Revoke API key" });
    await expect(revoke.getByText(`Revoke "${name}"? Anything using it stops working at once.`, { exact: false })).toBeVisible();
    const revoked = page.waitForResponse(
      (r) => r.request().method() === "DELETE" && r.url().includes(`/api/v1/orgs/${id}/api-keys/`),
    );
    await revoke.getByRole("button", { name: "Revoke", exact: true }).click();
    expect((await revoked).ok(), "the revoke request succeeded").toBe(true);
    await expect(revoke).toBeHidden({ timeout: 15_000 });

    // Gone from both lists (the same locators found it above), from the store, and from the API.
    for (const list of [own, all]) {
      await expect(list.getByRole("button", { name: `Revoke ${name}`, exact: true })).toHaveCount(0, { timeout: 15_000 });
    }
    expect(await prisma.apiKey.count({ where: { orgId: id, name } })).toBe(0);
    expect((await request.get(`/api/v1/orgs/${id}/projects`, asKey)).status(), "the revoked key is refused").toBe(401);
    await snap(page, "3-key-revoked");

    expect(errors).toEqual([]);
  });

  test("turning off member keys changes what a member sees", async ({ page, signInAs }) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const id = await orgId();
    const before = await prisma.orgSecuritySettings.findUnique({ where: { orgId: id } });

    // The member's page, as it is with the switch on.
    const expectMemberCanCreate = async () => {
      const own = page.getByRole("region", { name: "Your API keys" });
      await expect(own.getByRole("button", { name: "Create key" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(MEMBER_KEYS_OFF)).toHaveCount(0);
    };

    try {
      // Start from on, whatever an earlier run left behind; `before` is what gets restored.
      await prisma.orgSecuritySettings.upsert({
        where: { orgId: id },
        create: { orgId: id, memberApiKeysEnabled: true },
        update: { memberApiKeysEnabled: true },
      });

      await signInAs(MEMBER);
      await openApiKeys(page);
      await expectMemberCanCreate();

      // The admin turns it off and saves.
      await signInAs(ADMIN);
      await page.goto(`/${ORG}/settings/security`, { waitUntil: "domcontentloaded" });
      const toggle = page.getByRole("switch", { name: MEMBER_SWITCH });
      await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
      // Click only while it still reads on: a click before hydration is dropped, and a second one would turn it back.
      await expect(async () => {
        if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
        await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      const saved = page.waitForResponse(
        (r) => r.request().method() === "PUT" && r.url().endsWith(`/api/v1/orgs/${id}/security/settings`),
      );
      await page.getByRole("button", { name: "Save Settings" }).click();
      expect((await saved).status()).toBe(200);
      const stored = await prisma.orgSecuritySettings.findUnique({ where: { orgId: id }, select: { memberApiKeysEnabled: true } });
      expect(stored?.memberApiKeysEnabled).toBe(false);

      // The member's page now says why, and offers nothing to create.
      await signInAs(MEMBER);
      await openApiKeys(page);
      await expect(page.getByText(MEMBER_KEYS_OFF)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Create key" })).toHaveCount(0);
      expect(blocking(await runAxe(page))).toEqual([]);
      await snap(page, "4-member-keys-off");
    } finally {
      if (before) {
        const { id: _id, orgId: _org, createdAt: _created, updatedAt: _updated, ...fields } = before;
        await prisma.orgSecuritySettings.update({
          where: { orgId: id },
          data: { ...fields, actionRestrictions: fields.actionRestrictions as Prisma.InputJsonValue },
        });
      } else {
        await prisma.orgSecuritySettings.deleteMany({ where: { orgId: id } });
      }
    }

    // Restored, and the member's page follows (on, unless something before this run had it off).
    await page.reload({ waitUntil: "domcontentloaded" });
    if (before?.memberApiKeysEnabled === false) await expect(page.getByText(MEMBER_KEYS_OFF)).toBeVisible({ timeout: 15_000 });
    else await expectMemberCanCreate();
    await snap(page, "5-member-keys-restored");

    expect(errors).toEqual([]);
  });
});
