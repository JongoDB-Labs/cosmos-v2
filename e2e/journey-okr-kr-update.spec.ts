import { PrismaClient, KeyResultStatus, ObjectiveStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { test, expect } from "./fixtures/auth";

/**
 * E2E journey — update a Key Result's current value on the OKR board.
 *
 * alice (ADMIN → OKR_UPDATE) opens an objective on the board, expands it,
 * clicks the inline "{current} / {target}" value control of a Key Result,
 * types a new current value, saves, and the row re-renders with the new value
 * and recomputed progress %.
 *
 * Prerequisite seeding (why a beforeAll DB insert, not a UI flow): the OkrBoard
 * "Add Objective" UI only creates a *title-only* objective, the objectives POST
 * route ignores nested keyResults, and there is NO key-results CREATE route or
 * UI anywhere — so a Key Result can only be brought into existence directly in
 * the DB. The CI e2e job runs `npx tsx prisma/seed/test-fixtures.ts` and then
 * the Playwright runner in the SAME shell with DATABASE_URL set, so a Prisma
 * client here reaches the same Postgres. We look up the seeded test-org + TEST
 * project and insert one Objective + one Key Result, both stamped uniquely so
 * the shared CI DB / retries can't make selectors ambiguous. (Mutating; cleaned
 * up in afterAll via the objective cascade-delete.)
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const KEY = process.env.E2E_PROJECT_KEY ?? "test";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const stamp = Date.now().toString().slice(-6);
const OBJECTIVE_TITLE = `E2E KR Objective ${stamp}`;
const KR_TITLE = `E2E KR ${stamp}`;

// Seed a low starting value so the initial render is unambiguous and the
// update visibly moves both the KR value and the % bars. start=0 current=10
// target=100 → "10 / 100" @ 10%; updating to 60 → "60 / 100" @ 60%. 60 (not
// 100) avoids the cross-into-100% confetti dynamic import.
const START_VALUE = 0;
const INITIAL_CURRENT = 10;
const TARGET_VALUE = 100;
const NEW_CURRENT = 60;

let createdObjectiveId: string | null = null;

test.beforeAll(async () => {
  const org = await prisma.organization.findUnique({
    where: { slug: ORG },
    select: { id: true },
  });
  if (!org) throw new Error(`seed missing: org "${ORG}" not found`);

  const project = await prisma.project.findFirst({
    where: { orgId: org.id, key: { equals: KEY, mode: "insensitive" } },
    select: { id: true },
  });
  if (!project) throw new Error(`seed missing: project "${KEY}" not found`);

  const objective = await prisma.objective.create({
    data: {
      orgId: org.id,
      projectId: project.id,
      title: OBJECTIVE_TITLE,
      status: ObjectiveStatus.ACTIVE,
      progress: 0,
      keyResults: {
        create: {
          title: KR_TITLE,
          startValue: START_VALUE,
          currentValue: INITIAL_CURRENT,
          targetValue: TARGET_VALUE,
          unit: "",
          status: KeyResultStatus.IN_PROGRESS,
          sortOrder: 0,
        },
      },
    },
    select: { id: true },
  });
  createdObjectiveId = objective.id;
});

test.afterAll(async () => {
  // Key results cascade-delete with the objective.
  if (createdObjectiveId) {
    await prisma.objective
      .delete({ where: { id: createdObjectiveId } })
      .catch(() => {});
  }
  await prisma.$disconnect();
});

test.describe("journey — OKR key result update", () => {
  test("update a key result's current value and see it on the board", async ({
    page,
    signInAs,
  }) => {
    test.setTimeout(60_000);
    await signInAs(EMAIL);

    await page.goto(`/${ORG}/projects/${KEY}/okrs`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("main", { timeout: 20_000 });

    // Scope everything to OUR objective's card (unique stamped title) so the
    // shared CI DB / retries can't make any selector ambiguous.
    const card = page
      .locator("div.rounded-lg.border")
      .filter({ hasText: OBJECTIVE_TITLE })
      .first();
    await expect(card.getByText(OBJECTIVE_TITLE).first()).toBeVisible({
      timeout: 20_000,
    });

    // Cards render collapsed — click the header to expand and reveal the Key
    // Results section.
    await card.getByText(OBJECTIVE_TITLE).first().click();
    await expect(card.getByText(KR_TITLE).first()).toBeVisible({
      timeout: 15_000,
    });

    // The KR value is an inline button "current / target" (title="Click to
    // edit"). Confirm the seeded starting value, then click to edit.
    const valueButton = card.getByRole("button", {
      name: `${INITIAL_CURRENT} / ${TARGET_VALUE}`,
    });
    await expect(valueButton).toBeVisible({ timeout: 15_000 });
    await valueButton.click();

    // The button is swapped for a text input prefilled with the current value.
    const valueInput = card.getByRole("textbox");
    await expect(valueInput).toBeVisible({ timeout: 10_000 });
    await valueInput.fill(String(NEW_CURRENT));
    // Enter commits (KeyResultRow.handleSave) and closes the editor.
    await valueInput.press("Enter");

    // The board updates via a raw fetch + local-state refresh (NOT React
    // Query), so wait for the editor to CLOSE (deterministic post-save signal)
    // before asserting the new value rather than asserting immediately.
    await expect(valueInput).toBeHidden({ timeout: 15_000 });

    // The row re-renders with the new "current / target" value...
    await expect(
      card.getByRole("button", {
        name: `${NEW_CURRENT} / ${TARGET_VALUE}`,
      }),
    ).toBeVisible({ timeout: 20_000 });

    // ...and the recomputed progress %. (60-0)/(100-0)*100 = 60% — shown on
    // both the KR row and the objective header.
    await expect(card.getByText("60%").first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
