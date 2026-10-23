// @vitest-environment node
//
// Idempotency-Key against the real database (the seeded test-org): the unique
// (credential, key) index is the whole mechanism, so a mock would prove nothing.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { idempotent } from "../idempotency";
import { ProblemError } from "../problem";
import type { AuthContext } from "@/lib/rbac/check";
import { API_VERSION } from "../version";

const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;
let orgId: string;
let ctx: AuthContext;

beforeAll(async () => {
  process.env.SSO_VAULT_KEY = randomBytes(32).toString("base64");
  const org = await prisma.organization.findFirstOrThrow({ where: { slug: "test-org" } });
  orgId = org.id;
  ctx = {
    userId: randomUUID(), orgId, orgRole: "MEMBER", permissions: 0n, basePermissions: 0n, abacRules: [],
    isApiKey: true, credential: { kind: "api_key", keyId: randomUUID(), personal: true, apiVersion: API_VERSION },
  };
});
afterAll(async () => {
  await prisma.apiIdempotencyKey.deleteMany({ where: { credential: `key:${ctx.credential!.keyId}` } });
  process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
});

const post = (key: string | null, path = "/api/v1/orgs/o/goals") =>
  new Request(`http://x${path}`, { method: "POST", headers: key ? { "Idempotency-Key": key } : {} });

let runs = 0;
const created = (status = 201) => async () => {
  runs += 1;
  return NextResponse.json({ id: `goal-${runs}` }, { status });
};
beforeEach(() => { runs = 0; });

describe("Idempotency-Key", () => {
  it("without the header, every request runs", async () => {
    await idempotent({ request: post(null), ctx, orgId, body: { a: 1 } }, created());
    await idempotent({ request: post(null), ctx, orgId, body: { a: 1 } }, created());
    expect(runs).toBe(2);
  });

  it("a retry with the same key and body replays the first success and runs nothing", async () => {
    const key = randomUUID();
    const first = await idempotent({ request: post(key), ctx, orgId, body: { a: 1 } }, created());
    const again = await idempotent({ request: post(key), ctx, orgId, body: { a: 1 } }, created());
    expect(runs).toBe(1);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(await first.json());
    expect(again.headers.get("idempotent-replayed")).toBe("true");
  });

  it("the stored response is sealed at rest", async () => {
    const key = randomUUID();
    await idempotent({ request: post(key), ctx, orgId, body: {} }, created());
    const row = await prisma.apiIdempotencyKey.findFirstOrThrow({ where: { key } });
    expect(row.responseBody).not.toContain("goal-");
    expect(row.responseBody).toMatch(/^v2\./);
  });

  it("the same key with a different body (or path) is a 422, and runs nothing", async () => {
    const key = randomUUID();
    await idempotent({ request: post(key), ctx, orgId, body: { a: 1 } }, created());
    for (const [request, body] of [[post(key), { a: 2 }], [post(key, "/api/v1/orgs/o/kpis"), { a: 1 }]] as const) {
      const err = await idempotent({ request, ctx, orgId, body }, created()).catch((e) => e);
      expect(err).toBeInstanceOf(ProblemError);
      expect(err).toMatchObject({ status: 422, code: "idempotency_key_reused" });
    }
    expect(runs).toBe(1);
  });

  it("a duplicate while the first is still running is a 409", async () => {
    const key = randomUUID();
    let release!: () => void;
    const slow = idempotent({ request: post(key), ctx, orgId, body: {} }, async () => {
      await new Promise<void>((r) => { release = r; });
      return NextResponse.json({ ok: true }, { status: 201 });
    });
    await vi.waitFor(async () => expect(await prisma.apiIdempotencyKey.count({ where: { key } })).toBe(1));
    const err = await idempotent({ request: post(key), ctx, orgId, body: {} }, created()).catch((e) => e);
    expect(err).toMatchObject({ status: 409 });
    release();
    expect((await slow).status).toBe(201);
  });

  it("a failure keeps nothing, so a fixed retry with the same key runs", async () => {
    const key = randomUUID();
    const failed = await idempotent({ request: post(key), ctx, orgId, body: {} }, created(400));
    expect(failed.status).toBe(400);
    await idempotent({ request: post(key), ctx, orgId, body: {} }, created());
    expect(runs).toBe(2);
    const thrown = randomUUID();
    await expect(idempotent({ request: post(thrown), ctx, orgId, body: {} }, async () => { throw new Error("boom"); }))
      .rejects.toThrow("boom");
    expect(await prisma.apiIdempotencyKey.count({ where: { key: thrown } })).toBe(0);
  });

  it("keys are per credential: another token's identical key is unrelated", async () => {
    const key = randomUUID();
    const other = { ...ctx, credential: { kind: "api_key" as const, keyId: randomUUID(), personal: false, apiVersion: API_VERSION } };
    await idempotent({ request: post(key), ctx, orgId, body: {} }, created());
    await idempotent({ request: post(key), ctx: other, orgId, body: {} }, created());
    expect(runs).toBe(2);
    await prisma.apiIdempotencyKey.deleteMany({ where: { credential: `key:${other.credential.keyId}` } });
  });

  it("an expired key is free again", async () => {
    const key = randomUUID();
    await idempotent({ request: post(key), ctx, orgId, body: {} }, created());
    await prisma.apiIdempotencyKey.updateMany({ where: { key }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    await idempotent({ request: post(key), ctx, orgId, body: { different: true } }, created());
    expect(runs).toBe(2);
  });

  it("rejects a key that isn't printable ASCII", async () => {
    await expect(idempotent({ request: post("has space"), ctx, orgId, body: {} }, created()))
      .rejects.toMatchObject({ status: 400 });
  });
});
