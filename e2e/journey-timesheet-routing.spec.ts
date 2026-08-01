import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — a submitted timesheet reaches a NAMED person.
 *
 * Before routing existed, submitting a week flipped a status and told nobody:
 * there was no answer to "who am I submitting this to?", no notification, and
 * an approver had no way to learn a week was waiting. This asserts the whole
 * loop across TWO users, which is the only place the behaviour is real — a unit
 * test can prove the route is computed, but not that the notification arrives in
 * somebody else's session.
 *
 * Seeded org chart (prisma/seed/test-fixtures.ts): bob supervises alice. bob
 * holds no TIME_APPROVE and does not need it — supervising a report confers
 * approval authority on its own.
 *
 * Mutating — CI e2e job (Postgres + seed).
 *
 * WEEK ISOLATION, and why it is not optional: a timesheet is per PERIOD, and
 * `journey-time-tracking` submits alice's CURRENT week. Two specs competing for
 * one period means whichever runs second finds no "Submit week" button, because
 * the week is already submitted. This one works three weeks back.
 *
 * THE RESET IS DONE THROUGH THE API, NOT THE UI. A submitted period is closed to
 * edits, so a run that inherits a submitted week from a previous run cannot even
 * log time. Reading that state off the screen means racing the timesheet fetch —
 * which silently skips the reset and fails later, somewhere less obvious. The
 * API answers definitively before the journey starts.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const ALICE = process.env.E2E_EMAIL ?? "alice@test.local";
const BOB = "bob@test.local";

/** Monday of the week containing `d` — mirrors getWeekDates() in the component. */
function mondayOf(d: Date): Date {
  const x = new Date(d);
  const day = x.getDay();
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  x.setHours(0, 0, 0, 0);
  return x;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

const WEEKS_BACK = 3;

test.describe("journey — timesheet routing", () => {
  test("submitting names the approver, and notifies them", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(90_000);

    const target = mondayOf(
      new Date(Date.now() - WEEKS_BACK * 7 * 24 * 60 * 60 * 1000),
    );
    const targetDate = isoDate(target);
    const stamp = Date.now().toString().slice(-6);
    const description = `E2E Routing ${stamp}`;

    // ── how many submission notices bob already has ───────────────────────
    // Counted, not merely looked for. The CI database is shared across specs
    // and retries, and every run submits the SAME period, so a notification
    // from an earlier run sits in bob's list with an identical title and an
    // identical refId. Asserting only that the text is present passes even when
    // this run notifies nobody — which is exactly what mutation testing caught.
    await signInAs(BOB);

    // The org id is not in the URL (the path carries the slug), so take it from
    // the first API call the page makes rather than hardcoding a seeded UUID.
    const apiCall = page.waitForRequest((r) =>
      /\/api\/v1\/orgs\/[0-9a-f-]{36}\//.test(r.url()),
    );
    await page.goto(`/${ORG}/time-tracking`);
    const orgId = (await apiCall).url().match(/\/orgs\/([0-9a-f-]{36})\//)![1];

    const countSubmissionNotices = async (): Promise<number> => {
      const res = await page.request.get(`/api/v1/orgs/${orgId}/notifications`);
      const rows = await res.json();
      return (Array.isArray(rows) ? rows : []).filter(
        (n: { type?: string }) => n.type === "timesheet.submitted",
      ).length;
    };
    const noticesBefore = await countSubmissionNotices();

    // ── alice submits her week ────────────────────────────────────────────
    await signInAs(ALICE);
    await page.goto(`/${ORG}/time-tracking`);

    // Reset the target period to OPEN if an earlier run left it submitted.
    const listed = await page.request.get(
      `/api/v1/orgs/${orgId}/timesheets?periodStart=${targetDate}`,
    );
    const sheets = (await listed.json()).data ?? [];
    if (sheets[0] && sheets[0].status !== "OPEN") {
      const reset = await page.request.post(
        `/api/v1/orgs/${orgId}/timesheets/${sheets[0].id}`,
        {
          data: { action: "withdraw" },
          // The app refuses cross-origin mutating verbs (proxy.ts, csrf_blocked).
          // A browser sets Origin itself; APIRequestContext does not, so a
          // request that is legitimately same-origin has to say so.
          headers: { Origin: new URL(page.url()).origin },
        },
      );
      expect(reset.ok(), "could not reset the target week to OPEN").toBeTruthy();
      await page.reload();
    }

    const prev = page.getByRole("button", { name: /previous week/i }).first();
    await expect(prev).toBeVisible({ timeout: 20_000 });
    for (let i = 0; i < WEEKS_BACK; i++) await prev.click();

    const logTime = page.getByRole("button", { name: /log time/i }).first();
    await expect(logTime).toBeVisible({ timeout: 20_000 });
    await logTime.click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: /^Log Time$/i }),
    ).toBeVisible({ timeout: 15_000 });
    // The dialog defaults to TODAY, which belongs to a different timesheet.
    await dialog.locator("#te-date").fill(targetDate);
    await dialog.locator("#te-hours").fill("3");
    await dialog.locator("#te-desc").fill(description);
    await dialog.getByRole("button", { name: /^Save$/ }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // The entry showing in THIS week's grid proves the navigation landed where
    // the entry was dated — without it, everything below could be asserting
    // against a different period.
    await expect(page.getByText(description).first()).toBeVisible({
      timeout: 20_000,
    });

    // The button says where the week is going BEFORE it is pressed — the whole
    // point of resolving the route up front.
    const submitWeek = page.getByRole("button", { name: /submit week/i }).first();
    await expect(submitWeek).toBeEnabled({ timeout: 20_000 });
    await expect(submitWeek).toHaveAttribute("title", /Bob/i, {
      timeout: 15_000,
    });

    await submitWeek.click();

    // Named in the confirmation, not a generic "Submitted!".
    await expect(page.getByText(/submitted to Bob/i).first()).toBeVisible({
      timeout: 20_000,
    });

    // …and named persistently on the week, so the answer outlives the toast.
    await expect(page.getByText(/Waiting on Bob/i).first()).toBeVisible({
      timeout: 20_000,
    });

    // ── bob was told ──────────────────────────────────────────────────────
    // The half that cannot be tested in one session: the notification has to
    // arrive for the OTHER user.
    await signInAs(BOB);
    await page.goto(`/${ORG}/time-tracking`);

    // A NEW notice, not just the presence of one. This is the assertion that
    // actually fails when the notification is not raised.
    await expect
      .poll(countSubmissionNotices, { timeout: 20_000 })
      .toBe(noticesBefore + 1);

    // …and that it is legible in the product, not merely a row in a table.
    const bell = page.getByRole("button", { name: /notification/i }).first();
    await expect(bell).toBeVisible({ timeout: 20_000 });
    await bell.click();

    await expect(
      page.getByText(/Alice submitted a timesheet/i).first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});
