// @vitest-environment node
//
// The outbox worker and the webhook sender, against a real database: a
// committed change becomes one signed delivery per subscribed webhook, under
// the right event name, carrying ids and keys but no free text; failures are
// retried with backoff and then given up; nothing is queued twice.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHmac, randomBytes } from "crypto";
import { prisma } from "@/lib/db/client";
import { sealField } from "@/lib/crypto/field-seal";
import { ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { createWorkItemRow } from "@/lib/work-items/write.server";
import { applyWorkItemChange } from "@/lib/work-items/apply-change.server";
import { processOutboxBatch } from "./outbox.server";
import { MAX_ATTEMPTS, RETRY_DELAYS_MS, sendDueDeliveries, type Post } from "@/lib/webhooks/deliver.server";
import { OutboundRefused } from "@/lib/security/outbound-post.server";

let orgId = "";
let projectId = "";
let projectKey = "";
let userId = "";
let typeId = "";
let ticket = 0;
const SECRET = "whsec-test";
// Webhook secrets are sealed at rest; a throwaway key for this file.
const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;
process.env.SSO_VAULT_KEY ??= randomBytes(32).toString("base64");

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  userId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `ob ${stamp}`, slug: `ob-${stamp}` } })).id;
  projectKey = `OB${stamp.slice(-4).toUpperCase()}`;
  projectId = (await prisma.project.create({ data: { orgId, name: "O", key: projectKey } })).id;
  await ensureFixtureStatuses(projectId);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
});

beforeEach(async () => {
  await prisma.webhook.deleteMany({ where: { orgId } });
  // Leave nothing for the next test to pick up.
  await prisma.domainEvent.updateMany({ where: { orgId, processedAt: null }, data: { processedAt: new Date() } });
});

const hook = (events: string[], active = true) =>
  prisma.webhook.create({ data: { orgId, url: "https://hooks.example/in", events, secret: sealField(SECRET), active } });

async function createItem(title = "Merger with Initech") {
  const row = await createWorkItemRow(
    prisma,
    { data: { orgId, projectId, workItemTypeId: typeId, createdById: userId, title, description: "Board only", columnKey: "todo", ticketNumber: ++ticket }, select: { id: true } },
    { actorId: userId, source: "API" },
  );
  return row.id;
}

const move = (id: string, columnKey: string, source: "API" | "MIGRATION" = "API") =>
  prisma.$transaction((tx) => applyWorkItemChange(tx, { orgId, projectId, actorId: userId, actor: null, source, itemIds: [id], patch: { columnKey } }));

const run = () => processOutboxBatch(prisma, { orgId });
const deliveriesOf = (webhookId: string) => prisma.webhookDelivery.findMany({ where: { webhookId }, orderBy: [{ eventId: "asc" }, { createdAt: "asc" }] });

describe("the outbox worker", () => {
  it("queues one delivery per subscribed webhook, under the event's name, with ids and keys only", async () => {
    const created = await hook(["work_item.created"]);
    const other = await hook(["work_item.updated"]);
    const id = await createItem("Merger with Initech");
    const r = await run();
    expect(r).toMatchObject({ queued: 1 });
    const [d] = await deliveriesOf(created.id);
    expect(d).toMatchObject({ event: "work_item.created", status: "PENDING", attempts: 0 });
    expect(d.nextAttemptAt).not.toBeNull();
    expect(d.payload).toMatchObject({ type: "work_item.created", orgId, projectId, workItem: { id, key: `${projectKey}-${ticket}` }, actorId: userId, source: "API" });
    // Never the title or description.
    expect(JSON.stringify(d.payload)).not.toMatch(/Initech|Board only/);
    expect(await deliveriesOf(other.id)).toHaveLength(0);
    // Every event the batch read is marked processed.
    expect(await prisma.domainEvent.count({ where: { orgId, processedAt: null } })).toBe(0);
  });

  it("delivers a move into Done as work_item.completed, and other moves as work_item.transitioned", async () => {
    const both = await hook(["work_item.transitioned", "work_item.completed"]);
    const done = await hook(["work_item.completed"]);
    const id = await createItem();
    await move(id, "in-progress");
    await move(id, "done");
    await run();
    // The move into Done is both: a subscriber to every transition still gets it.
    expect((await deliveriesOf(both.id)).map((d) => d.event).sort()).toEqual(["work_item.completed", "work_item.transitioned", "work_item.transitioned"]);
    expect((await deliveriesOf(done.id)).map((d) => [d.event, (d.payload as { change: { to: string } }).change.to])).toEqual([["work_item.completed", "done"]]);
  });

  it("delivers nothing for a MIGRATION move or to a switched-off webhook, and still marks the events processed", async () => {
    const on = await hook(["work_item.transitioned"]);
    const off = await hook(["work_item.created", "work_item.transitioned"], false);
    const id = await createItem();
    await run();
    await move(id, "in-progress", "MIGRATION");
    const r = await run();
    expect(r.events).toBeGreaterThan(0);
    expect(await deliveriesOf(on.id)).toHaveLength(0);
    expect(await deliveriesOf(off.id)).toHaveLength(0);
    expect(await prisma.domainEvent.count({ where: { orgId, processedAt: null } })).toBe(0);
  });

  it("never queues an event twice, even when it is processed again", async () => {
    const h = await hook(["work_item.created"]);
    const id = await createItem();
    await run();
    await prisma.domainEvent.updateMany({ where: { subjectId: id }, data: { processedAt: null } });
    await run();
    expect(await deliveriesOf(h.id)).toHaveLength(1);
  });

  it("leaves another worker's claimed events alone (SKIP LOCKED) and takes them once they're free", async () => {
    const h = await hook(["work_item.created"]);
    await createItem();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let claimed!: () => void;
    const ready = new Promise<void>((r) => (claimed = r));
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM domain_events WHERE org_id = ${orgId}::uuid AND processed_at IS NULL FOR UPDATE`;
      claimed();
      await held;
    }, { timeout: 15_000 });
    await ready;
    expect(await run()).toEqual({ events: 0, queued: 0 });
    release();
    await holder;
    expect(await run()).toMatchObject({ queued: 1 });
    expect(await deliveriesOf(h.id)).toHaveLength(1);
  });
});

describe("the webhook sender", () => {
  async function queued(events = ["work_item.created"]) {
    const h = await hook(events);
    await createItem();
    await run();
    return h;
  }

  it("signs each delivery the way the docs say and records the response", async () => {
    const h = await queued();
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const post: Post = async (url, o) => {
      calls.push({ url, headers: o.headers, body: o.body });
      return { status: 204, body: "" };
    };
    const r = await sendDueDeliveries(prisma, { post });
    expect(r.succeeded).toBeGreaterThanOrEqual(1);
    const [d] = await deliveriesOf(h.id);
    expect(d).toMatchObject({ status: "SUCCESS", attempts: 1, statusCode: 204, nextAttemptAt: null });
    const call = calls.find((c) => c.headers["X-Webhook-Delivery"] === d.id)!;
    expect(call.url).toBe("https://hooks.example/in");
    expect(call.headers["X-Webhook-Signature"]).toBe(`sha256=${createHmac("sha256", SECRET).update(call.body).digest("hex")}`);
    expect(JSON.parse(call.body)).toMatchObject({ event: "work_item.created", data: { type: "work_item.created" } });
  });

  it("retries a failure after the next delay, and gives up after the last attempt", async () => {
    const h = await queued();
    const [d] = await deliveriesOf(h.id);
    let t = Date.now();
    const now = () => new Date(t);
    const fail: Post = async () => ({ status: 500, body: "boom" });
    const failOne: Post = async (url, o) => (o.headers["X-Webhook-Delivery"] === d.id ? fail(url, o) : { status: 200, body: "" });
    await sendDueDeliveries(prisma, { post: failOne, now });
    let row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ status: "PENDING", attempts: 1, statusCode: 500, responseBody: "boom" });
    expect(row.nextAttemptAt!.getTime()).toBe(t + RETRY_DELAYS_MS[0]);
    // Not due yet: nothing is sent.
    await sendDueDeliveries(prisma, { post: failOne, now });
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).attempts).toBe(1);
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      t = row.nextAttemptAt!.getTime();
      await sendDueDeliveries(prisma, { post: failOne, now });
      row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.attempts).toBe(attempt);
    }
    expect(row).toMatchObject({ status: "FAILED", attempts: MAX_ATTEMPTS, nextAttemptAt: null });
  });

  it("records a refused address as a failed attempt, and doesn't send for a webhook switched off since", async () => {
    const h = await queued();
    const [d] = await deliveriesOf(h.id);
    const refuse: Post = async () => {
      throw new OutboundRefused("hooks.example resolves to an address that isn't public");
    };
    await sendDueDeliveries(prisma, { post: refuse });
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: "PENDING", attempts: 1, statusCode: null, responseBody: expect.stringMatching(/isn't public/) });

    await prisma.webhook.update({ where: { id: h.id }, data: { active: false } });
    await prisma.webhookDelivery.update({ where: { id: d.id }, data: { nextAttemptAt: new Date(0) } });
    let sent = 0;
    await sendDueDeliveries(prisma, { post: async () => (sent++, { status: 200, body: "" }) });
    expect(sent).toBe(0);
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: "FAILED", nextAttemptAt: null });
  });

  it("leases what it takes, so a second sender running at once doesn't send it again", async () => {
    const h = await queued();
    const [d] = await deliveriesOf(h.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow: Post = async (_url, o) => {
      if (o.headers["X-Webhook-Delivery"] === d.id) calls++;
      await gate;
      return { status: 200, body: "" };
    };
    const first = sendDueDeliveries(prisma, { post: slow });
    // Let the first sender lease and start sending before the second looks.
    await new Promise((r) => setTimeout(r, 300));
    await sendDueDeliveries(prisma, { post: async (_u, o) => (o.headers["X-Webhook-Delivery"] === d.id && calls++, { status: 200, body: "" }) });
    release();
    await first;
    expect(calls).toBe(1);
  });
});
