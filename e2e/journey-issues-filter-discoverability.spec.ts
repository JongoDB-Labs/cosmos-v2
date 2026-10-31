import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { test, expect } from "./fixtures/auth";
import { setQueryLanguage, openIssues } from "./fixtures/issues-query";

/**
 * E2E journey — the Issues filter bar is DISCOVERABLE, not merely capable.
 *
 * This file exists because three defects shipped that every unit test was blind
 * to, and all three were reported as the feature not existing:
 *
 *   1. "Save as board" had no e2e assertion anywhere, so moving it in 2.499.0
 *      was verified by the test suite and the prod health endpoint and by
 *      nothing that looks at a screen. It was then reported missing.
 *   2. A value picker could not be searched by name: the client-side filter read
 *      `searchText ?? label`, and the CQL pickers pass a row's detail as
 *      searchText, so typing a sprint's own name matched nothing. jsdom specs
 *      with a mocked fetch cover the predicate; only a real browser against the
 *      real /cql/suggest proves the chain.
 *   3. `sprint` and `pi` are two fields over one entity and neither scoped its
 *      suggestions by kind, so both listed every interval with nothing to tell a
 *      PI from a sprint.
 *
 * So the assertions here are deliberately about PRESENCE and FINDABILITY — can a
 * person see the control, and can they type the word they know? A spec that only
 * asserted the query ran would have passed throughout all three.
 *
 * Prerequisite seeding (why a beforeAll DB insert): `prisma/seed/test-fixtures.ts`
 * seeds NO intervals at all, so a sprint-picker assertion against the seed would
 * be green over an empty list — proving nothing, which is the failure this file
 * is about. We insert one PROGRAM_INCREMENT and one SPRINT on the seeded TEST
 * project, stamped uniquely so the shared CI DB and retries cannot make a
 * selector ambiguous. Interval numbers are unique per project, so the stamp
 * feeds those too. Cleaned up in afterAll.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const KEY = process.env.E2E_PROJECT_KEY ?? "test";

const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const stamp = Date.now().toString().slice(-6);
const PI_NAME = `E2E PI ${stamp}`;
const SPRINT_NAME = `E2E Sprint ${stamp}`;
// `number` is unique per project, so the two rows need DIFFERENT numbers. An
// earlier version built them as `Number(`9${stamp}`.slice(-5))` and
// `Number(`8${stamp}`.slice(-5))` — the slice took the last 5 of a 7-char
// string and threw the 9/8 away, so both came out identical and the second
// insert died on `intervals_project_id_number_key`. Derive one base and add.
const BASE_NUMBER = (Number(stamp) % 99_000) + 100;
const createdIds: string[] = [];

test.beforeAll(async () => {
  const org = await prisma.organization.findUnique({ where: { slug: ORG }, select: { id: true } });
  if (!org) throw new Error(`seed missing: org "${ORG}" not found`);
  const project = await prisma.project.findFirst({
    where: { orgId: org.id, key: { equals: KEY, mode: "insensitive" } },
    select: { id: true },
  });
  if (!project) throw new Error(`seed missing: project "${KEY}" not found`);

  const base = { orgId: org.id, projectId: project.id, startDate: new Date("2026-07-01"), endDate: new Date("2026-09-30") };
  const pi = await prisma.interval.create({
    data: { ...base, name: PI_NAME, intervalKind: "PROGRAM_INCREMENT", status: "ACTIVE", number: BASE_NUMBER },
  });
  const sprint = await prisma.interval.create({
    data: { ...base, name: SPRINT_NAME, intervalKind: "SPRINT", status: "ACTIVE", number: BASE_NUMBER + 1, parentId: pi.id },
  });
  createdIds.push(sprint.id, pi.id);

  // Fail loudly rather than let a later assertion report "not found" as if the
  // UI were at fault: this spec is only meaningful if both rows exist.
  expect(createdIds).toHaveLength(2);
});

test.afterAll(async () => {
  for (const id of createdIds) await prisma.interval.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
});

test.describe("journey — Issues filters are findable", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  async function signIn(page: import("@playwright/test").Page) {
    const r = await page.request.post(`${process.env.E2E_BASE_URL ?? "http://localhost:3000"}/api/testenv/sign-in`, {
      data: { email: EMAIL },
      headers: { Origin: process.env.E2E_BASE_URL ?? "http://localhost:3000" },
    });
    if (!r.ok()) throw new Error(`sign-in failed: ${r.status()}`);
  }

  test("Save as board is on screen — including when the filter matches nothing", async ({ page }) => {
    test.setTimeout(90_000);
    await setQueryLanguage(page.request, true);
    try {
      // A query that deliberately matches no item. A board is a live view over a
      // query, so an empty one is valid — and this is the exact state the
      // control used to be hidden in, because it lived inside `rows.length > 0`.
      await openIssues(page, { cql: `summary ~ "zzz-no-such-item-${stamp}"` });

      await expect(page.getByRole("button", { name: /Save as board/i })).toBeVisible({ timeout: 30_000 });
      // And it sits with the other query controls, not in the results area.
      await expect(page.getByRole("button", { name: "Save filter" })).toBeVisible();
    } finally {
      await setQueryLanguage(page.request, false);
    }
  });

  test("Add filter answers to the word you'd type: `interval` finds Sprint", async ({ page }) => {
    test.setTimeout(90_000);
    await setQueryLanguage(page.request, true);
    try {
      await openIssues(page);
      await page.getByRole("combobox", { name: "Add filter" }).click();
      const search = page.getByPlaceholder("Field or person…");
      await search.fill("interval");

      // "Sprint" carries the registry aliases `interval` and `iteration`; its
      // LABEL contains neither, so matching the label alone found nothing here.
      await expect(page.getByRole("option", { name: "Sprint" })).toBeVisible({ timeout: 15_000 });

      await search.fill("pi");
      await expect(page.getByRole("option", { name: "Program increment" })).toBeVisible({ timeout: 15_000 });
    } finally {
      await setQueryLanguage(page.request, false);
    }
  });

  test("a sprint can be found in the Sprint picker by typing its name", async ({ page }) => {
    test.setTimeout(90_000);
    await setQueryLanguage(page.request, true);
    try {
      await openIssues(page);
      await page.getByRole("combobox", { name: "Add filter" }).click();
      await page.getByPlaceholder("Field or person…").fill("Sprint");
      await page.getByRole("option", { name: "Sprint" }).click();

      const values = page.getByLabel("Sprint values");
      await expect(values).toBeVisible({ timeout: 15_000 });
      await values.click();
      // The seeded sprint's own NAME. This matched zero options before 2.505.0,
      // because the detail ("TEST · sprint · active") replaced the label.
      await page.getByPlaceholder("Search…").fill(SPRINT_NAME);
      await expect(page.getByRole("option", { name: new RegExp(SPRINT_NAME) })).toBeVisible({ timeout: 15_000 });
    } finally {
      await setQueryLanguage(page.request, false);
    }
  });

  test("the Program increment picker offers the PI and not the sprint inside it", async ({ page }) => {
    test.setTimeout(90_000);
    await setQueryLanguage(page.request, true);
    try {
      await openIssues(page);
      await page.getByRole("combobox", { name: "Add filter" }).click();
      await page.getByPlaceholder("Field or person…").fill("Program increment");
      await page.getByRole("option", { name: "Program increment" }).click();

      const values = page.getByLabel("Program increment values");
      await expect(values).toBeVisible({ timeout: 15_000 });
      await values.click();
      // Both rows are named "E2E ... <stamp>", so this one search string reaches
      // either — which is what makes the absence of the sprint meaningful.
      await page.getByPlaceholder("Search…").fill(`E2E `);

      await expect(page.getByRole("option", { name: new RegExp(PI_NAME) })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("option", { name: new RegExp(SPRINT_NAME) })).toHaveCount(0);
    } finally {
      await setQueryLanguage(page.request, false);
    }
  });
});
