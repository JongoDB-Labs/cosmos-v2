// @vitest-environment node
//
// Opaque-handle store unit tests. Locks the threat-model invariants of the
// mint/resolve primitive (the deeper red-team / loop-integration tests live in
// __tests__/handles-redteam.test.ts):
//   - isHandle shape recognition (h:<24 base64url chars>);
//   - mint → resolve round-trip within a conversation;
//   - WRONG conversationId → null (conversation scope = cross-tenant boundary);
//   - fabricated / unknown token → null;
//   - the minted row seals the value (value_enc is a vault envelope, NOT plaintext)
//     and the token carries no CUI;
//   - resolveHandlesDeep: whole-string match only, bounded depth, counts subs.
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// In-memory prisma double keyed by token (mirrors @@unique([token])).
const { store, prisma } = vi.hoisted(() => {
  const store = new Map<string, { conversationId: string; token: string; valueEnc: string; entityType: string; fieldName: string }>();
  return {
    store,
    prisma: {
      egressHandle: {
        create: vi.fn(async ({ data }: { data: { conversationId: string; token: string; valueEnc: string; entityType: string; fieldName: string } }) => {
          if (store.has(data.token)) {
            const err = new Error("Unique constraint failed") as Error & { code: string };
            err.code = "P2002";
            throw err;
          }
          store.set(data.token, { ...data });
          return { id: crypto.randomUUID(), createdAt: new Date(), ...data };
        }),
        findUnique: vi.fn(async ({ where }: { where: { token: string } }) => {
          const row = store.get(where.token);
          return row ? { id: "row", createdAt: new Date(), ...row } : null;
        }),
      },
    },
  };
});

vi.mock("@/lib/db/client", () => ({ prisma }));

// Real vault key so seal/open round-trips for real (proves value_enc is an envelope).
const KEY = crypto.randomBytes(32).toString("base64");

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  delete process.env.SSO_VAULT_KEYS;
  delete process.env.SSO_VAULT_ACTIVE_KID;
  process.env.SSO_VAULT_KEY = KEY;
});

import { isHandle, mintHandle, resolveHandle, resolveHandlesDeep } from "./handles";

const CONV_A = "conv-aaaa";
const CONV_B = "conv-bbbb";

describe("isHandle", () => {
  it("recognizes a real minted token shape h:<24 base64url chars>", () => {
    const tok = "h:" + crypto.randomBytes(18).toString("base64url");
    expect(tok).toMatch(/^h:[A-Za-z0-9_-]{24}$/);
    expect(isHandle(tok)).toBe(true);
  });

  it("rejects non-handles", () => {
    expect(isHandle("not a handle")).toBe(false);
    expect(isHandle("h:tooShort")).toBe(false);
    expect(isHandle("h:" + "x".repeat(25))).toBe(false); // wrong length
    expect(isHandle("h:" + "x".repeat(23))).toBe(false);
    expect(isHandle("prefix h:" + crypto.randomBytes(18).toString("base64url"))).toBe(false); // embedded, not whole
    expect(isHandle("h:invalid+chars/here==aa")).toBe(false); // + / = not in base64url
    expect(isHandle(42)).toBe(false);
    expect(isHandle(null)).toBe(false);
    expect(isHandle(undefined)).toBe(false);
  });
});

describe("mint → resolve round-trip", () => {
  it("mints an unguessable token and resolves it back to the real value in the same conversation", async () => {
    const CUI = "CUI//SP Sentinel kill-chain timeline 2026";
    const token = await mintHandle(CONV_A, CUI, { entityType: "work_item", fieldName: "description" });

    expect(isHandle(token)).toBe(true);
    // The token is random — it does NOT encode the value.
    expect(token).not.toContain("Sentinel");
    expect(token).not.toContain("CUI");

    const resolved = await resolveHandle(CONV_A, token);
    expect(resolved).toBe(CUI);
  });

  it("seals the value at rest — value_enc is a vault envelope (v2.<kid>...), NEVER plaintext", async () => {
    const CUI = "CUI//SP exfil path in sensor fusion";
    const token = await mintHandle(CONV_A, CUI, { entityType: "note", fieldName: "content" });

    const row = store.get(token)!;
    expect(row).toBeDefined();
    expect(row.valueEnc).toMatch(/^v2\./); // sealed envelope
    expect(row.valueEnc).not.toContain("Sentinel");
    expect(row.valueEnc).not.toContain(CUI);
    expect(row.valueEnc).not.toContain("exfil");
    // metadata is non-CUI only
    expect(row.entityType).toBe("note");
    expect(row.fieldName).toBe("content");
  });
});

describe("conversation scope (cross-tenant boundary)", () => {
  it("a token minted in conversation A does NOT resolve in conversation B → null", async () => {
    const CUI = "CUI//SP cross-tenant secret";
    const token = await mintHandle(CONV_A, CUI, { entityType: "work_item", fieldName: "title" });

    // Same token, DIFFERENT conversation → must not resolve.
    expect(await resolveHandle(CONV_B, token)).toBeNull();
    // Sanity: it DOES resolve in its own conversation.
    expect(await resolveHandle(CONV_A, token)).toBe(CUI);
  });
});

describe("fabricated / unknown tokens", () => {
  it("a syntactically valid but never-minted token → null", async () => {
    const fake = "h:" + crypto.randomBytes(18).toString("base64url");
    expect(await resolveHandle(CONV_A, fake)).toBeNull();
  });

  it("a malformed token → null (and never hits the DB)", async () => {
    expect(await resolveHandle(CONV_A, "h:short")).toBeNull();
    expect(await resolveHandle(CONV_A, "literally not a handle")).toBeNull();
    expect(prisma.egressHandle.findUnique).not.toHaveBeenCalled();
  });
});

describe("resolveHandlesDeep", () => {
  it("substitutes a whole-string handle in nested args; counts substitutions", async () => {
    const CUI = "CUI//SP withheld description text";
    const token = await mintHandle(CONV_A, CUI, { entityType: "work_item", fieldName: "description" });

    const input = {
      title: "Filed from work item A",
      content: token, // whole-string handle → resolved
      meta: { tags: ["a", token] }, // nested handle in an array → resolved
      untouched: "just a normal string",
    };
    const { resolved, count } = await resolveHandlesDeep(input, CONV_A);
    expect(count).toBe(2);
    const r = resolved as typeof input;
    expect(r.content).toBe(CUI);
    expect((r.meta.tags as string[])[1]).toBe(CUI);
    expect(r.untouched).toBe("just a normal string");
    expect(r.title).toBe("Filed from work item A");
  });

  it("does NOT substitute a handle EMBEDDED in a larger string (exact whole-string match only)", async () => {
    const CUI = "CUI//SP embedded";
    const token = await mintHandle(CONV_A, CUI, { entityType: "note", fieldName: "content" });

    const input = { content: `prefix ${token} suffix` };
    const { resolved, count } = await resolveHandlesDeep(input, CONV_A);
    expect(count).toBe(0);
    expect((resolved as { content: string }).content).toBe(`prefix ${token} suffix`);
    expect((resolved as { content: string }).content).not.toContain(CUI);
  });

  it("passes a wrong-conversation handle through literally (count 0, never the CUI)", async () => {
    const CUI = "CUI//SP wrong conv";
    const token = await mintHandle(CONV_A, CUI, { entityType: "work_item", fieldName: "title" });

    const { resolved, count } = await resolveHandlesDeep({ x: token }, CONV_B);
    expect(count).toBe(0);
    expect((resolved as { x: string }).x).toBe(token); // literal token, NOT the value
    expect(JSON.stringify(resolved)).not.toContain(CUI);
  });

  it("stops at the bounded depth (does not resolve below MAX_RESOLVE_DEPTH)", async () => {
    const CUI = "CUI//SP deep";
    const token = await mintHandle(CONV_A, CUI, { entityType: "note", fieldName: "content" });

    // Bury the token 8 levels deep (> MAX_RESOLVE_DEPTH = 6).
    let node: unknown = token;
    for (let i = 0; i < 8; i++) node = { next: node };
    const { count } = await resolveHandlesDeep(node, CONV_A);
    expect(count).toBe(0);
  });
});
