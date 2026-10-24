// @vitest-environment node
//
// A key acts as the user who minted it, so an audit entry's userId can't say
// whether a person did something in the app or a script did it with their key.
// logAudit now records how the request authenticated (`authMethod`) and, for a
// key, which one (`apiKeyId`), read from the request. Against a real database.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";

const h = vi.hoisted(() => ({ headers: null as Headers | null }));
vi.mock("next/headers", () => ({
  headers: async () => {
    if (!h.headers) throw new Error("`headers` was called outside a request scope");
    return h.headers;
  },
}));

import { logAudit } from "./audit";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", owner = "", keyId = "";
const PREFIX = "a1b2c3d4e5f6";
const EXPIRED_PREFIX = "f6e5d4c3b2a1";
const SECRET = "the-real-secret";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: `owner-${stamp}@audit.test`, displayName: "Owner" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `au ${stamp}`, slug: `au-${stamp}` } })).id;
  keyId = (await prisma.apiKey.create({
    data: { orgId, name: "ci", prefix: PREFIX, keyHash: sha256(SECRET), scopes: ["items:write"], createdById: owner },
  })).id;
  await prisma.apiKey.create({
    data: { orgId, name: "old", prefix: EXPIRED_PREFIX, keyHash: sha256(SECRET), scopes: ["items:write"], createdById: owner, expiresAt: new Date("2020-01-01T00:00:00Z") },
  });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: owner } }).catch(() => undefined);
});

beforeEach(() => { h.headers = null; });

/** Log one entry and read back its metadata. */
async function logged(metadata?: Record<string, string>) {
  const action = `test.${Math.random().toString(36).slice(2, 8)}`;
  await logAudit({ orgId, userId: owner, action, entity: "work_item", ...(metadata && { metadata }) });
  return (await prisma.auditLog.findFirstOrThrow({ where: { orgId, action } })).metadata as Record<string, unknown>;
}

describe("logAudit records how the request authenticated", () => {
  it("a valid API key: the method and which key", async () => {
    h.headers = new Headers({ authorization: `Bearer cosmos_${PREFIX}_${SECRET}`, cookie: "session=abc" });
    expect(await logged({ title: "t" })).toEqual({ title: "t", authMethod: "api_key", apiKeyId: keyId });
  });

  it("a browser session", async () => {
    h.headers = new Headers({ cookie: "theme=dark; session=abc" });
    expect(await logged({ title: "t" })).toEqual({ authMethod: "session", title: "t" });
  });

  it("outside a request (a job), nothing is added", async () => {
    expect(await logged({ title: "t" })).toEqual({ title: "t" });
  });

  it("the caller's own metadata wins on a clash", async () => {
    h.headers = new Headers({ cookie: "session=abc" });
    expect(await logged({ authMethod: "import" })).toEqual({ authMethod: "import" });
  });
});

describe("a session user can't forge the attribution", () => {
  // A route that authenticates by cookie alone ignores the bearer, so these
  // writes are the session's. None of them may be pinned on a key.
  it.each([
    ["someone's real key prefix with a wrong secret", `Bearer cosmos_${PREFIX}_guessed`],
    ["an expired key, right secret", `Bearer cosmos_${EXPIRED_PREFIX}_${SECRET}`],
    ["a prefix this org doesn't have", "Bearer cosmos_ffffffffffff_secret"],
    ["an OAuth-shaped token (none authenticate yet)", "Bearer cosmos_oat_abc123_secret"],
  ])("%s → session, no key", async (_name, authorization) => {
    h.headers = new Headers({ authorization, cookie: "session=abc" });
    expect(await logged()).toEqual({ authMethod: "session" });
  });

  it("made-up headers claiming a method or a key are ignored", async () => {
    h.headers = new Headers({ cookie: "session=abc", "x-auth-method": "api_key", "x-api-key-id": keyId, "x-cosmos-api-key-id": keyId });
    expect(await logged()).toEqual({ authMethod: "session" });
  });
});
