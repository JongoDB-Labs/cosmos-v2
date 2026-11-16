import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — Meetings. From the org Meetings page, open the "Schedule
 * Meeting" dialog, fill the minimal required field (title; type defaults to
 * Standup and the date defaults to now), create the meeting, and verify it
 * appears in the list.
 *
 * Mutating — runs in the CI e2e job (Postgres + test-fixtures seed). The create
 * flow needs no project/cycle (project is optional, type/date default), so this
 * uses only the seeded org. alice is ADMIN so she has MEETING_CREATE. Unique
 * title per run so retries on the shared CI DB don't clash.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

test.describe("journey — meetings", () => {
  test("create a meeting and see it in the list", async ({ page, signInAs }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    const stamp = Date.now().toString().slice(-6);
    const title = `E2E Meeting ${stamp}`;

    await page.goto(`/${ORG}/meetings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 20_000 });

    // Open the create dialog ("Schedule Meeting" trigger button). The button is
    // server-rendered, so it is visible about 1.5s before React hydrates it
    // under `next dev`, and a click in that window does nothing (it failed
    // every local run; CI's retries hid it). Re-click until the dialog opens
    // rather than sleeping: the assertion is still that the button opens it.
    await expect(async () => {
      await page
        .getByRole("button", { name: /schedule meeting/i })
        .first()
        .click();
      await expect(
        page.getByRole("heading", { name: /schedule meeting/i }),
      ).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });

    // Fill the only required field — title. Type defaults to Standup and the
    // date/time defaults to "now", so a minimal path needs nothing else.
    await page.getByLabel(/^Title$/).fill(title);

    await page.getByRole("button", { name: /^create$/i }).click();

    // The new meeting appears in the list (client re-fetch after create).
    await expect(page.getByText(title).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  // A meeting next month used to be listed under "Past", and a card's ⋯ menu
  // never showed on hover: its `group/action` was on the card, and ActionMenu
  // renders the trigger as the card's sibling, so only focus or a right-click
  // found it. Seeded through the API (and deleted after), so the list holds a
  // future meeting whatever day the suite runs.
  test("a meeting next month is Upcoming, and hovering its card shows its ⋯ menu", async ({ page, signInAs, baseURL }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);
    const base = baseURL ?? "http://localhost:3000";
    const orgs = await (await page.request.get("/api/v1/orgs")).json();
    const org = ((orgs.data ?? orgs) as { id: string; slug: string }[]).find((o) => o.slug === ORG)!;
    const title = `E2E Next month ${Date.now().toString().slice(-6)}`;
    const res = await page.request.post(`/api/v1/orgs/${org.id}/meetings`, {
      data: { title, meetingDate: new Date(Date.now() + 32 * 24 * 3600 * 1000).toISOString() },
      headers: { Origin: base },
    });
    expect(res.status(), await res.text()).toBe(201);
    const meeting = (await res.json()) as { id: string };
    try {
      await page.goto(`/${ORG}/meetings`, { waitUntil: "domcontentloaded" });
      const section = (name: string) => page.getByRole("heading", { level: 2, name, exact: true }).locator("xpath=..");
      await expect(section("Upcoming").getByText(title, { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(section("Past").getByText(title, { exact: true })).toHaveCount(0);

      const trigger = page.getByRole("button", { name: `Actions for ${title}` });
      // The positive control: hidden while the pointer is elsewhere.
      await page.mouse.move(0, 0);
      await expect(trigger).toHaveCSS("opacity", "0");
      await page.getByText(title, { exact: true }).hover();
      await expect(trigger).toHaveCSS("opacity", "1");
      // Over the card, and nothing paints on top of it: a real pointer reaches it.
      const reachable = await trigger.evaluate((t) => {
        const r = t.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit === t || t.contains(hit);
      });
      expect(reachable).toBe(true);
      await trigger.click();
      await expect(page.getByRole("menuitem", { name: "Open" })).toBeVisible();
    } finally {
      await page.request.delete(`/api/v1/orgs/${org.id}/meetings/${meeting.id}`, { headers: { Origin: base } });
    }
  });
});
