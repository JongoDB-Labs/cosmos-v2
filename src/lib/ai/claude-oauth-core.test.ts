// @vitest-environment node
//
// Shared Claude OAuth PKCE core — the store-and-scope-parameterized engine
// extracted out of claude-subscription.ts (per-org) and user-claude-subscription.ts
// (per-user) so a THIRD caller (Foreman's own dedicated connection, task 3) can
// reuse it with a broader scope + a different TokenStore, with zero duplicated
// PKCE/token-endpoint logic. This suite exercises the core in isolation — no
// prisma, no Next.js route — via a fake in-memory TokenStore. It pins:
//   1. exchange SEALS the tokens (via the real vault) and hands the sealed
//      strings to the store, not the plaintext.
//   2. getToken auto-refreshes within the 5-minute skew window and persists
//      the refreshed token back to the store.
//   3. initiate is scope-PARAMETERIZED (not hardcoded) and builds a real PKCE
//      S256 challenge from the verifier it returns.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { openSecret, sealSecret } from "@/lib/crypto/vault";
import {
  initiateClaudeOAuthCore,
  exchangeClaudeCodeCore,
  getClaudeTokenCore,
  CLAUDE_SCOPE_INFERENCE,
  CLAUDE_SCOPE_CODE,
  type TokenStore,
} from "./claude-oauth-core";

/* -------------------------------------------------------------------------- */
/*  Vault env — sealSecret/openSecret read process.env at call time            */
/* -------------------------------------------------------------------------- */

const VAULT_KEY = crypto.randomBytes(32).toString("base64");
const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;

beforeAll(() => {
  process.env.SSO_VAULT_KEY = VAULT_KEY;
  delete process.env.SSO_VAULT_KEYS;
  delete process.env.SSO_VAULT_ACTIVE_KID;
});

afterAll(() => {
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*  Fake in-memory TokenStore                                                  */
/* -------------------------------------------------------------------------- */

type Row = { access: unknown; refresh: unknown; expiresAt: Date | null };
type WrittenRow = { access: unknown; refresh: unknown; expiresAt: Date };

/**
 * A prisma-free stand-in for the real TokenStore adapters. `write()` wraps the
 * sealed strings it receives in the same `{ sealed }` shape the real adapters
 * persist into their Json columns, so `lastWrite()` mirrors what would actually
 * land in the DB (and the test can `openSecret()` it straight back).
 */
function fakeStore(seed: Row | null = null) {
  let row: Row | null = seed;
  let last: WrittenRow | null = null;
  const store: TokenStore & { lastWrite(): WrittenRow } = {
    async read() {
      return row;
    },
    async write(sealed) {
      const written: WrittenRow = {
        access: { sealed: sealed.access },
        refresh: sealed.refresh != null ? { sealed: sealed.refresh } : null,
        expiresAt: sealed.expiresAt,
      };
      last = written;
      row = written;
    },
    lastWrite() {
      if (!last) throw new Error("fakeStore: write() was never called");
      return last;
    },
  };
  return store;
}

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

/* -------------------------------------------------------------------------- */
/*  Suite                                                                      */
/* -------------------------------------------------------------------------- */

describe("claude-oauth-core", () => {
  describe("exchangeClaudeCodeCore", () => {
    it("exchange writes sealed access+refresh+expiry to the store", async () => {
      const store = fakeStore();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }))),
      );

      const r = await exchangeClaudeCodeCore("CODE#S", "VER", "S", store);

      expect(r.success).toBe(true);
      const w = store.lastWrite();
      expect(openSecret((w.access as { sealed: string }).sealed)).toBe("AT");
      expect(openSecret((w.refresh as { sealed: string }).sealed)).toBe("RT");
      expect(w.expiresAt).toBeInstanceOf(Date);
    });

    it("rejects a state mismatch without ever calling the token endpoint", async () => {
      const store = fakeStore();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const r = await exchangeClaudeCodeCore("CODE#WRONG-STATE", "VER", "EXPECTED-STATE", store);

      expect(r.success).toBe(false);
      expect(r.error).toMatch(/state/i);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(() => store.lastWrite()).toThrow();
    });

    it("surfaces a failed token-endpoint response without writing to the store", async () => {
      const store = fakeStore();
      vi.stubGlobal("fetch", tokenResponse({ error: "invalid_grant" }, 400));

      const r = await exchangeClaudeCodeCore("BADCODE", "VER", "", store);

      expect(r.success).toBe(false);
      expect(() => store.lastWrite()).toThrow();
    });
  });

  describe("getClaudeTokenCore", () => {
    it("refreshes an about-to-expire token and returns the new one", async () => {
      const nearExpiry = new Date(Date.now() + 60 * 1000); // 1 min out — inside the 5-min skew
      const store = fakeStore({
        access: { sealed: sealSecret("AT1") },
        refresh: { sealed: sealSecret("RT1") },
        expiresAt: nearExpiry,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }))),
      );

      const token = await getClaudeTokenCore(store);

      expect(token).toBe("AT2");
      // The refreshed token is persisted back so the next call skips refreshing again.
      expect(openSecret((store.lastWrite().access as { sealed: string }).sealed)).toBe("AT2");
    });

    it("returns the existing token unchanged when it is not near expiry (no network call)", async () => {
      const farExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour out
      const store = fakeStore({
        access: { sealed: sealSecret("AT-STILL-GOOD") },
        refresh: { sealed: sealSecret("RT-STILL-GOOD") },
        expiresAt: farExpiry,
      });
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const token = await getClaudeTokenCore(store);

      expect(token).toBe("AT-STILL-GOOD");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns null when the store has no connection at all", async () => {
      const store = fakeStore(null);
      expect(await getClaudeTokenCore(store)).toBeNull();
    });
  });

  describe("initiateClaudeOAuthCore", () => {
    it("embeds the requested scope + S256 challenge", () => {
      const { url } = initiateClaudeOAuthCore(CLAUDE_SCOPE_CODE);

      expect(url).toContain("scope=user%3Ainference+user%3Aprofile+user%3Asessions%3Aclaude_code");
      expect(url).toContain("code_challenge_method=S256");
    });

    it("embeds the narrower inference-only scope when that's what's passed (parameterized, not hardcoded)", () => {
      const { url } = initiateClaudeOAuthCore(CLAUDE_SCOPE_INFERENCE);

      expect(url).toContain("scope=user%3Ainference+user%3Aprofile");
      expect(url).not.toContain("claude_code");
    });

    it("returns a verifier whose SHA-256/base64url matches the URL's code_challenge", () => {
      const { url, verifier, state } = initiateClaudeOAuthCore(CLAUDE_SCOPE_INFERENCE);

      const expectedChallenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const params = new URL(url).searchParams;
      expect(params.get("code_challenge")).toBe(expectedChallenge);
      expect(params.get("state")).toBe(state);
    });
  });
});
