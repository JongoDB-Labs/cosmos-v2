import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — an unsupervised worker is refused, and given a way out.
 *
 * A week from somebody nobody supervises used to be accepted, routed to the
 * admin pool or to nobody, and then sit unapproved with no one aware of it. The
 * block turns that silent dead end into a prompt; this asserts the whole loop
 * across TWO users, which is the only place it is real — a unit test can prove
 * the gate refuses, but not that the request reaches somebody else's session.
 *
 * CAROL IS THE SUBJECT, and the choice is forced rather than arbitrary. The gate
 * refuses an unsupervised employee only when somebody COULD supervise them, and
 * neither of the other two seeded users qualifies for the other:
 * `assignableSupervisors` excludes anyone who reports up through you, so alice
 * is not offerable to bob (she reports to him) and bob holds no TIME_APPROVE.
 * alice is supervised already. carol is the one shape that is actually blocked.
 *
 * Mutating — CI e2e job (Postgres + seed).
 *
 * WEEK ISOLATION: a timesheet is per PERIOD and other specs submit alice's
 * current week. This one works five weeks back, clear of both of them.
 *
 * IDEMPOTENCE: the CI database is shared across specs and retries. A previous
 * run leaves carol's request row in place, so the notification is counted
 * before and after rather than merely looked for — an identical title and refId
 * from an earlier run would otherwise satisfy a presence check even when this
 * run notified nobody. The request itself is deleted up front for the same
 * reason: the unique index makes a repeat request a no-op by design.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const ALICE = process.env.E2E_EMAIL ?? "alice@test.local";
const CAROL = "carol@test.local";

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

const WEEKS_BACK = 5;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/**
 * Clear carol's open requests, and any supervisor she was given.
 *
 * BOTH are required for a repeatable run, and each fails differently if it is
 * skipped. A leftover request row makes the new one a no-op — that is the spam
 * guard working as designed — so nobody is notified and the notification count
 * never moves. A leftover supervisor edge (from an earlier run, or a human
 * poking at the seed org) exempts carol from the block entirely, and the spec
 * fails at the banner having proved nothing.
 *
 * The CI e2e job runs the seed and the Playwright runner in the SAME shell with
 * DATABASE_URL set, so this client reaches the same Postgres.
 */
test.beforeAll(async () => {
  const org = await prisma.organization.findUnique({
    where: { slug: ORG },
    select: { id: true },
  });
  if (!org) throw new Error(`seed missing: org "${ORG}" not found`);

  const carol = await prisma.user.findFirst({
    where: { email: CAROL },
    select: { id: true },
  });
  if (!carol) throw new Error(`seed missing: user "${CAROL}" not found`);

  const employee = await prisma.employee.findFirst({
    where: { orgId: org.id, userId: carol.id },
    select: { id: true },
  });
  if (!employee) {
    throw new Error(`seed missing: no employee record for "${CAROL}"`);
  }

  await prisma.supervisorRequest.deleteMany({
    where: { orgId: org.id, employeeId: employee.id },
  });
  await prisma.employeeSupervisor.deleteMany({
    where: { orgId: org.id, employeeId: employee.id },
  });
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("journey — submission requires a supervisor", () => {
  test("refuses an unsupervised week, and the request reaches an approver", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(90_000);

    const target = mondayOf(
      new Date(Date.now() - WEEKS_BACK * 7 * 24 * 60 * 60 * 1000),
    );
    const targetDate = isoDate(target);
    const stamp = Date.now().toString().slice(-6);
    const description = `E2E Supervisor ${stamp}`;

    // ── how many supervisor requests alice already has ────────────────────
    await signInAs(ALICE);
    const apiCall = page.waitForRequest((r) =>
      /\/api\/v1\/orgs\/[0-9a-f-]{36}\//.test(r.url()),
    );
    await page.goto(`/${ORG}/time-tracking`);
    const orgId = (await apiCall).url().match(/\/orgs\/([0-9a-f-]{36})\//)![1];

    const countRequestNotices = async (): Promise<number> => {
      const res = await page.request.get(`/api/v1/orgs/${orgId}/notifications`);
      const rows = await res.json();
      return (Array.isArray(rows) ? rows : []).filter(
        (n: { type?: string }) => n.type === "employee.supervisor_requested",
      ).length;
    };
    const noticesBefore = await countRequestNotices();

    // ── carol logs time and is REFUSED ────────────────────────────────────
    await signInAs(CAROL);
    await page.goto(`/${ORG}/time-tracking`);

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
    await dialog.locator("#te-hours").fill("2");
    await dialog.locator("#te-desc").fill(description);
    await dialog.getByRole("button", { name: /^Save$/ }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Proves the navigation landed on the week the entry was dated for.
    await expect(page.getByText(description).first()).toBeVisible({
      timeout: 20_000,
    });

    // The block is announced BEFORE the button is pressed, standing rather than
    // as a tooltip — a hover hint is invisible to someone who never hovers.
    await expect(page.getByText(/You have no supervisor set/i).first()).toBeVisible(
      { timeout: 20_000 },
    );

    // Pressing Submit opens the way out instead of reporting a dead end.
    const submitWeek = page.getByRole("button", { name: /submit week/i }).first();
    await expect(submitWeek).toBeEnabled({ timeout: 20_000 });
    await submitWeek.click();

    const requestDialog = page.getByRole("dialog");
    await expect(
      requestDialog.getByRole("heading", { name: /Ask someone to supervise you/i }),
    ).toBeVisible({ timeout: 20_000 });

    // The week did NOT go through — the refusal is the point.
    await expect(page.getByText(/submitted to/i)).toHaveCount(0);

    // ── carol asks alice ──────────────────────────────────────────────────
    // alice is offerable: she holds TIME_APPROVE and does not report to carol.
    await requestDialog.getByText("Alice", { exact: true }).click();
    await requestDialog.getByRole("button", { name: /send request/i }).click();
    await expect(requestDialog).toBeHidden({ timeout: 20_000 });

    // ── alice was told ────────────────────────────────────────────────────
    // The half that cannot be tested in one session: it has to arrive for the
    // OTHER user. A NEW notice, not merely the presence of one.
    await signInAs(ALICE);
    await page.goto(`/${ORG}/time-tracking`);

    await expect
      .poll(countRequestNotices, { timeout: 20_000 })
      .toBe(noticesBefore + 1);

    // …and that it is legible in the product, not merely a row in a table.
    const bell = page.getByRole("button", { name: /notification/i }).first();
    await expect(bell).toBeVisible({ timeout: 20_000 });
    await bell.click();

    await expect(
      page.getByText(/Carol asked you to be their supervisor/i).first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});
