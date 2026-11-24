import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { test, expect } from "./fixtures/auth";
import { noisePngDataUri } from "../src/lib/users/__tests__/noise-png";

/**
 * Slow initial board load: the board's work-items list inlined every
 * assignee's `data:` avatar on every row. A few people with avatars, assigned
 * to hundreds of items, made it most of 16 MB, and base64 does not compress.
 *
 * The list now carries a URL to the avatar endpoint. This checks both halves
 * in a real browser: the list stays small, and the card's avatar still
 * decodes (not just a 200).
 *
 * Seeding (why a beforeAll DB insert): ~500 items is too many to create
 * through the UI. Its own project and person, stamped per run, so the seeded
 * test-org data is never changed. Cleaned up in afterAll.
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";
const ITEMS = 500;

const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const stamp = Date.now().toString().slice(-6);
const KEY = `AV${stamp}`;
const FIRST = `E2E Avatar item ${stamp} 1`;
// A real, decodable PNG that does not compress (~16 KB as base64).
const PNG = noisePngDataUri(64);

let projectId = "";
let userId = "";

test.beforeAll(async () => {
  const org = await prisma.organization.findUnique({ where: { slug: ORG }, select: { id: true } });
  if (!org) throw new Error(`seed missing: org "${ORG}" not found`);
  const alice = await prisma.user.findFirst({ where: { email: EMAIL }, select: { id: true } });
  if (!alice) throw new Error(`seed missing: user "${EMAIL}" not found`);
  const type = await prisma.workItemType.findFirst({ where: { orgId: null, key: { endsWith: ".task" } }, select: { id: true } });
  if (!type) throw new Error("seed missing: the built-in task type");

  userId = (
    await prisma.user.create({
      data: { email: `e2e-avatar-${stamp}@test.local`, displayName: `E2E Ava ${stamp}`, avatarUrl: PNG },
      select: { id: true },
    })
  ).id;
  await prisma.orgMember.create({ data: { orgId: org.id, userId, role: "MEMBER" } });

  projectId = (
    await prisma.project.create({ data: { orgId: org.id, name: `E2E Avatars ${stamp}`, key: KEY }, select: { id: true } })
  ).id;
  await prisma.board.create({
    data: {
      orgId: org.id, projectId, name: "Kanban", slug: "kanban", type: "KANBAN", sortOrder: 0,
      columns: { create: [{ name: "To Do", key: "todo", category: "TODO", sortOrder: 0 }] },
    },
  });
  await prisma.workflowStatus.create({ data: { orgId: org.id, projectId, key: "todo", name: "To Do", category: "TODO", sortOrder: 0 } });

  await prisma.workItem.createMany({
    data: Array.from({ length: ITEMS }, (_, i) => ({
      orgId: org.id, projectId, workItemTypeId: type.id, createdById: alice.id, assigneeId: userId,
      title: `E2E Avatar item ${stamp} ${i + 1}`, description: "", columnKey: "todo", ticketNumber: i + 1, sortOrder: i,
    })),
  });
  const items = await prisma.workItem.findMany({ where: { projectId }, select: { id: true } });
  await prisma.workItemAssignee.createMany({ data: items.map((it) => ({ workItemId: it.id, userId, sortOrder: 0 })) });
});

test.afterAll(async () => {
  if (projectId) await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => undefined);
  if (userId) await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  await prisma.$disconnect();
});

test.describe("board load — assignee avatars are not inlined", () => {
  test("the work-items list stays small and the card avatar still renders", async ({ page, signInAs }) => {
    test.setTimeout(120_000);
    await signInAs(EMAIL);

    const listResponse = page.waitForResponse(
      (r) => /\/api\/v1\/orgs\/[^/]+\/projects\/[^/]+\/work-items(\?.*)?$/.test(r.url()) && r.request().method() === "GET",
      { timeout: 60_000 },
    );
    const started = Date.now();
    await page.goto(`/${ORG}/projects/${KEY}/boards/kanban`, { waitUntil: "domcontentloaded" });
    const res = await listResponse;
    const body = await res.body();
    await expect(page.getByText(FIRST, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    const firstCardMs = Date.now() - started;
    const timing = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((e) => /\/work-items(\?|$)/.test(e.name))
        .map((e) => Math.round((e as PerformanceResourceTiming).responseEnd)),
    );
    console.log(`[perf] board-avatars: work-items=${body.length}B firstCard=${firstCardMs}ms workItemsResponseEnd=${timing.join(",")}ms`);

    expect(res.status()).toBe(200);
    const rows = JSON.parse(body.toString()) as { data?: unknown[] } | unknown[];
    expect(Array.isArray(rows) ? rows : rows.data).toHaveLength(ITEMS);
    expect(body.toString()).not.toContain("data:image");
    expect(body.length, "the list must not carry the avatar once per row").toBeLessThan(1_000_000);

    // The avatar actually decoded in the browser, not just answered 200.
    const img = page.locator(`img[src*="/users/${userId}/avatar"]`).first();
    await expect(img).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 15_000 })
      .toBe(64);
  });
});
