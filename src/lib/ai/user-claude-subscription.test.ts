// @vitest-environment node
//
// Direct coverage for makeUserTokenStore's write() stamping — the per-user
// TokenStore adapter (user-claude-subscription.ts) that binds the shared
// claude-oauth-core.ts engine to UserAiSettings. This adapter is NEW code
// (not verbatim-moved), with a conditional `activate` flag that only the
// exchange path sets true — so it gets its own direct exercise against the
// REAL e2e DB (prisma is not mocked; only the Claude token endpoint `fetch`
// is stubbed, same as claude-oauth-core.test.ts). Pins:
//   1. exchangeUserClaudeCode (activate: true) stamps `provider: "claude-oauth"`
//      even on the UPDATE branch — i.e. it (re-)activates Claude OAuth as the
//      user's provider even if the row previously read something else — and
//      the sealed access token round-trips back out through getUserClaudeToken.
//   2. getUserClaudeToken's auto-refresh path (activate: false, the default)
//      leaves an existing provider completely untouched.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { prisma } from "@/lib/db/client";
import { openSecret, sealSecret } from "@/lib/crypto/vault";
import { exchangeUserClaudeCode, getUserClaudeToken } from "./user-claude-subscription";

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

function tokenResponse(body: Record<string, unknown>) {
  return vi.fn(async () => new Response(JSON.stringify(body)));
}

/* -------------------------------------------------------------------------- */
/*  Suite (e2e DB)                                                             */
/* -------------------------------------------------------------------------- */

describe("makeUserTokenStore write() stamping (e2e DB, via user-claude-subscription.ts's public exports)", () => {
  const cleanup: { userIds: string[] } = { userIds: [] };
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: cleanup.userIds } } }).catch(() => undefined);
  });

  async function makeUser() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const user = await prisma.user.create({
      data: { email: `user-token-store-test-${stamp}@test.local`, displayName: "User Token Store Test" },
    });
    cleanup.userIds.push(user.id);
    return user;
  }

  it("exchange (re-)activates provider=claude-oauth on an existing row, and the sealed access token round-trips via getUserClaudeToken", async () => {
    const user = await makeUser();
    // Seed a row that already exists with some OTHER provider — proves the
    // exchange path's `activate: true` flips it back to "claude-oauth" on the
    // UPDATE branch, not just on first-create (where it'd be set anyway).
    await prisma.userAiSettings.create({
      data: { userId: user.id, provider: "sentinel-provider" },
    });

    vi.stubGlobal(
      "fetch",
      tokenResponse({ access_token: "USER-AT1", refresh_token: "USER-RT1", expires_in: 3600 }),
    );

    const result = await exchangeUserClaudeCode(user.id, "CODE#STATE", "VERIFIER", "STATE");
    expect(result.success).toBe(true);

    const row = await prisma.userAiSettings.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.provider).toBe("claude-oauth");
    expect(openSecret((row.oauthAccessToken as { sealed: string }).sealed)).toBe("USER-AT1");
    expect(row.oauthExpiresAt).toBeInstanceOf(Date);

    // Round-trip through the module's own get-token entry point. The token is
    // nowhere near its 5-minute refresh skew, so this must NOT hit the network.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(getUserClaudeToken(user.id)).resolves.toBe("USER-AT1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("getUserClaudeToken's auto-refresh write leaves an existing provider untouched", async () => {
    const user = await makeUser();
    // Seed a row with a near-expiry token (inside the 5-min skew, so
    // getUserClaudeToken's internal getClaudeTokenCore triggers a refresh) and
    // a sentinel provider distinct from "claude-oauth" — if the refresh path
    // ever started stamping `provider` unconditionally (activate defaults to
    // false on this path), it would clobber the sentinel and fail below.
    const nearExpiry = new Date(Date.now() + 60 * 1000);
    await prisma.userAiSettings.create({
      data: {
        userId: user.id,
        provider: "sentinel-provider-2",
        oauthAccessToken: { sealed: sealSecret("USER-AT-OLD") },
        oauthRefreshToken: { sealed: sealSecret("USER-RT-OLD") },
        oauthExpiresAt: nearExpiry,
      },
    });

    vi.stubGlobal(
      "fetch",
      tokenResponse({ access_token: "USER-AT-NEW", refresh_token: "USER-RT-NEW", expires_in: 3600 }),
    );

    await expect(getUserClaudeToken(user.id)).resolves.toBe("USER-AT-NEW");

    const row = await prisma.userAiSettings.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.provider).toBe("sentinel-provider-2");
    expect(openSecret((row.oauthAccessToken as { sealed: string }).sealed)).toBe("USER-AT-NEW");
  });
});
