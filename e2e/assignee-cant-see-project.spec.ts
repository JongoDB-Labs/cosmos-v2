import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { test, expect } from "./fixtures/auth";
import { runAxe } from "./fixtures/axe";

/**
 * E2E journey — assigning someone who can't see the project.
 *
 * An assignee who can't see a team-scoped project hears nothing of the
 * assignment, and can't open the item. The person assigning is told instead:
 * the detail sheet's Assignees picker marks them ("Can't see this project"),
 * assigning one there warns, and the Issues list's "Assign to" says so in its
 * confirmation. The marks come from the server, judged as each member.
 *
 * Seeding (why a beforeAll DB insert): a team-scoped project with one member
 * on it and one off it, and a work item in it. Its own project and people,
 * stamped per run, so the seeded test-org data is never changed and a retry
 * on the same database can't collide. Cleaned up in afterAll. alice (ADMIN)
 * sees every project, so she can open and assign the item.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const stamp = Date.now().toString().slice(-6);
const INSIDER = `E2E Ivy ${stamp}`;
const OUTSIDER = `E2E Otto ${stamp}`;
const TITLE = `E2E Locked item ${stamp}`;
const WARNING = `${OUTSIDER} can't see this project, so they can't open this item and won't be notified.`;

let projectId = "";
let itemId = "";
let outsiderId = "";
const userIds: string[] = [];

test.beforeAll(async () => {
  const org = await prisma.organization.findUnique({ where: { slug: ORG }, select: { id: true } });
  if (!org) throw new Error(`seed missing: org "${ORG}" not found`);
  const alice = await prisma.user.findFirst({ where: { email: EMAIL }, select: { id: true } });
  if (!alice) throw new Error(`seed missing: user "${EMAIL}" not found`);
  const type = await prisma.workItemType.findFirst({ where: { orgId: null, key: { endsWith: ".task" } }, select: { id: true } });
  if (!type) throw new Error("seed missing: the built-in task type");

  const [insider, outsider] = await Promise.all(
    [INSIDER, OUTSIDER].map((displayName, i) =>
      prisma.user.create({ data: { email: `e2e-reach-${i}-${stamp}@test.local`, displayName }, select: { id: true } }),
    ),
  );
  userIds.push(insider.id, outsider.id);
  outsiderId = outsider.id;
  const insiderMember = await prisma.orgMember.create({ data: { orgId: org.id, userId: insider.id, role: "MEMBER" }, select: { id: true } });
  await prisma.orgMember.create({ data: { orgId: org.id, userId: outsider.id, role: "MEMBER" } });

  const project = await prisma.project.create({
    data: { orgId: org.id, name: `E2E Locked ${stamp}`, key: `LK${stamp}`, teamScopedAccess: true },
    select: { id: true },
  });
  projectId = project.id;
  await prisma.projectMember.create({ data: { projectId, orgMemberId: insiderMember.id } });
  await prisma.workflowStatus.create({ data: { orgId: org.id, projectId, key: "todo", name: "To Do", category: "TODO", sortOrder: 0 } });
  itemId = (
    await prisma.workItem.create({
      data: { orgId: org.id, projectId, workItemTypeId: type.id, createdById: alice.id, title: TITLE, description: "", columnKey: "todo", ticketNumber: 1 },
      select: { id: true },
    })
  ).id;
});

test.afterAll(async () => {
  if (projectId) await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => undefined);
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  await prisma.$disconnect();
});

test.describe("journey — assigning someone who can't see the project", () => {
  test("the Assignees picker marks them, and assigning one warns", async ({ page, signInAs }) => {
    test.setTimeout(90_000);
    await signInAs(EMAIL);
    await page.goto(`/${ORG}/work-items?item=${itemId}`, { waitUntil: "domcontentloaded" });
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText(TITLE).first()).toBeVisible({ timeout: 30_000 });

    await sheet.getByRole("combobox", { name: "Assignees" }).click();
    const otto = page.getByRole("option", { name: OUTSIDER });
    const ivy = page.getByRole("option", { name: INSIDER });
    await expect(otto).toBeVisible({ timeout: 15_000 });
    // The mark arrives with the server's answer; the member on the project has none.
    await expect(otto).toHaveAccessibleDescription("Can't see this project", { timeout: 15_000 });
    await expect(ivy).toBeVisible();
    await expect(ivy).toHaveAccessibleDescription("");

    // The open picker, marks and all, passes axe. Scoped to its popup: the
    // sheet behind it is not what this checks.
    await page.getByRole("listbox").evaluate((list) => list.parentElement!.setAttribute("data-axe-scope", "assignee-picker"));
    await expect(page.locator("[data-axe-scope=assignee-picker]").getByRole("option", { name: OUTSIDER })).toBeVisible();
    const violations = await runAxe(page, { include: "[data-axe-scope=assignee-picker]" });
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("assignee-picker-marked.png") });

    await otto.click();
    await expect(page.getByText(WARNING)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath("assignee-warning.png") });
    // The assignment itself went through: a warning, not a refusal.
    await expect
      .poll(async () => (await prisma.workItemAssignee.findMany({ where: { workItemId: itemId }, select: { userId: true } })).map((a) => a.userId))
      .toEqual([outsiderId]);
  });

  test("the Issues list's Assign to says so in its confirmation", async ({ page, signInAs }) => {
    test.setTimeout(90_000);
    await prisma.workItemAssignee.deleteMany({ where: { workItemId: itemId } });
    await prisma.workItem.update({ where: { id: itemId }, data: { assigneeId: null } });
    await signInAs(EMAIL);
    await page.goto(`/${ORG}/work-items`, { waitUntil: "domcontentloaded" });
    const row = page.getByRole("row", { name: new RegExp(TITLE) });
    await expect(row).toBeVisible({ timeout: 30_000 });

    await row.getByRole("button", { name: "Row actions" }).click();
    await page.getByRole("menuitem", { name: "Assign to" }).click();
    await page.getByRole("menuitem", { name: OUTSIDER }).click();
    await expect(page.getByText(`Assigned to ${OUTSIDER}. ${WARNING}`)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath("issues-assign-warning.png") });
    await expect
      .poll(async () => (await prisma.workItem.findUniqueOrThrow({ where: { id: itemId }, select: { assigneeId: true } })).assigneeId)
      .toBe(outsiderId);

    // Positive control: assigning the member on the project confirms plainly.
    await row.getByRole("button", { name: "Row actions" }).click();
    await page.getByRole("menuitem", { name: "Assign to" }).click();
    await page.getByRole("menuitem", { name: INSIDER }).click();
    await expect(page.getByText(`Assigned to ${INSIDER}`, { exact: true })).toBeVisible({ timeout: 15_000 });
  });
});
