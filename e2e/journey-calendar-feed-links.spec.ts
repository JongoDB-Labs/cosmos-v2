import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createHash, randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { blocking, runAxe } from "./fixtures/axe";

/**
 * E2E journey: a calendar link that single sign-on has stopped says so.
 *
 * An org that requires sign-in through its IdP holds a calendar link to the
 * rule a member's API key is held to: only a link made through that IdP is
 * served. A link made before the rule came in stops. The person's list of
 * links says so under that link, in the feed's own words, and a link they make
 * now, signed in through the IdP, shows no warning.
 *
 * Why the setup is a beforeAll DB insert: single sign-on can't be driven in a
 * test (there is no IdP to sign in through), and requiring it of the seeded org
 * would lock every other spec out. So this spec makes its own org, IdP
 * connection, person and SSO session, and signs in by that session's cookie.
 * The org's calendar switch is turned on through the settings route, as an
 * admin does. Cleaned up in afterAll.
 */

const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const stamp = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const SLUG = `cfl-e2e-${stamp}`;
const SSO_TEXT = "Not active: it wasn't made through this organization's single sign-on.";
let orgId = "";
let userId = "";
let session = "";

test.beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `Calendar links ${stamp}`, slug: SLUG }, select: { id: true } });
  orgId = org.id;
  const conn = await prisma.idpConnection.create({
    data: {
      orgId, issuerUrl: "https://idp.example.test", clientId: "c", clientSecretEnc: "not-opened-by-this-spec",
      enabled: true, enforced: true,
    },
  });
  userId = (await prisma.user.create({ data: { email: `cfl-e2e-${stamp}@feeds.test`, displayName: `Feed person ${stamp}` } })).id;
  // ADMIN: they turn the org's calendar switch on themselves, as an admin does.
  await prisma.orgMember.create({ data: { orgId, userId, role: "ADMIN" } });
  session = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: { id: session, userId, expiresAt: new Date(Date.now() + 86_400_000), authMethod: "oidc", idpConnId: conn.id },
  });
  // Made before single sign-on was required: no IdP behind it.
  await prisma.calendarFeed.create({
    data: {
      orgId, userId, options: {}, idpConnId: null, createdAt: new Date(Date.now() - 7 * 86_400_000),
      tokenHash: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("hex"),
    },
  });
});

test.afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  await prisma.$disconnect();
});

test("a link single sign-on stopped says why; a new one made through it doesn't", async ({ page, baseURL }) => {
  // next dev compiles the settings page on first visit.
  test.setTimeout(90_000);
  const base = baseURL ?? "http://localhost:3000";
  await page.context().addCookies([{ name: "session", value: session, url: base }]);
  const on = await page.request.put(`${base}/api/v1/orgs/${orgId}/calendar-feeds/settings`, {
    data: { enabled: true },
    headers: { Origin: base },
  });
  expect(on.status(), await on.text()).toBe(200);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/${SLUG}/settings/preferences`, { waitUntil: "domcontentloaded" });

  const stopped = page.getByRole("group", { name: "Calendar link 1" });
  await expect(stopped).toContainText(SSO_TEXT, { timeout: 30_000 });
  await expect(stopped).toContainText(/make a new link/i);

  // Signed in through the IdP, the person makes a new link. It works, so it says nothing.
  await page.getByRole("button", { name: "Make another link" }).click();
  await expect(page.getByRole("status", { name: "New calendar link" })).toBeVisible();
  const fresh = page.getByRole("group", { name: "Calendar link 2" });
  await expect(fresh).toContainText("Link 2"); // the positive control: this is the new row
  await expect(fresh).not.toContainText("Not active");
  expect(await prisma.calendarFeed.count({ where: { orgId, userId, idpConnId: { not: null } } })).toBe(1);

  // Both themes, at desktop and phone width: the warning and the Revoke button
  // are the critical colour's text shade, and a phone gets the settings picker.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme });
      await expect(stopped).toContainText(SSO_TEXT);
      const serious = blocking(await runAxe(page));
      expect(
        serious,
        `serious/critical a11y violations on the calendar links (${width}px, ${colorScheme}):\n` +
          serious.map((v) => `  [${v.impact}] ${v.id} — ${v.help} @ ${v.targets[0]}`).join("\n"),
      ).toHaveLength(0);
    }
  }

  // Revoking the stopped link takes it, and its warning, off the list.
  await stopped.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText(SSO_TEXT)).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Calendar link 1" })).not.toContainText("Not active");
});
