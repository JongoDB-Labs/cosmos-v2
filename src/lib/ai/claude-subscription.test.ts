// @vitest-environment node
//
// Direct coverage for makeOrgTokenStore's write() stamping — the per-org
// TokenStore adapter (claude-subscription.ts) that binds the shared
// claude-oauth-core.ts engine to OrgAiSettings. This adapter is NEW code (not
// verbatim-moved from the pre-refactor module), with conditional
// `provider`/`updatedById` stamping that only the exchange path exercises —
// so it gets its own direct exercise against the REAL e2e DB (prisma is not
// mocked; only the Claude token endpoint `fetch` is stubbed, same as
// claude-oauth-core.test.ts). Pins:
//   1. exchangeClaudeCode (the explicit, user-initiated connect) stamps BOTH
//      `provider: "claude-oauth"` and `updatedById` on write, and the sealed
//      access token round-trips back out through getOrgClaudeToken.
//   2. A refresh-triggered write (refreshOrgClaudeToken — no updatedById arg)
//      leaves an existing provider/updatedById completely untouched, exactly
//      as the pre-refactor code only ever stamped them on an explicit exchange.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { prisma } from "@/lib/db/client";
import { openSecret } from "@/lib/crypto/vault";
import { exchangeClaudeCode, refreshOrgClaudeToken, getOrgClaudeToken } from "./claude-subscription";

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

describe("makeOrgTokenStore write() stamping (e2e DB, via claude-subscription.ts's public exports)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `org-token-store-test ${stamp}`, slug: `org-token-store-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    return { org, owner };
  }

  it("exchange stamps provider + updatedById, and the sealed access token round-trips via getOrgClaudeToken", async () => {
    const { org, owner } = await makeOrg();
    vi.stubGlobal(
      "fetch",
      tokenResponse({ access_token: "ORG-AT1", refresh_token: "ORG-RT1", expires_in: 3600 }),
    );

    const result = await exchangeClaudeCode(org.id, "CODE#STATE", "VERIFIER", "STATE", owner.id);
    expect(result.success).toBe(true);

    const row = await prisma.orgAiSettings.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(row.provider).toBe("claude-oauth");
    expect(row.updatedById).toBe(owner.id);
    expect(openSecret((row.oauthAccessToken as { sealed: string }).sealed)).toBe("ORG-AT1");
    expect(row.oauthExpiresAt).toBeInstanceOf(Date);

    // Round-trip through the module's own get-token entry point. The token is
    // nowhere near its 5-minute refresh skew, so this must NOT hit the network.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(getOrgClaudeToken(org.id)).resolves.toBe("ORG-AT1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a refresh-triggered write leaves an existing provider/updatedById untouched", async () => {
    const { org, owner } = await makeOrg();
    vi.stubGlobal(
      "fetch",
      tokenResponse({ access_token: "ORG-AT1", refresh_token: "ORG-RT1", expires_in: 3600 }),
    );
    await exchangeClaudeCode(org.id, "CODE#STATE", "VERIFIER", "STATE", owner.id);

    // Simulate the row having drifted to some OTHER provider/updatedById since
    // the exchange — sentinels distinct from both "claude-oauth" and
    // `owner.id`, so a regression that made the refresh path stamp
    // unconditionally (instead of omitting the keys entirely) would clobber
    // these and fail the assertions below.
    const sentinelUpdatedById = crypto.randomUUID();
    await prisma.orgAiSettings.update({
      where: { orgId: org.id },
      data: { provider: "sentinel-provider", updatedById: sentinelUpdatedById },
    });

    vi.stubGlobal(
      "fetch",
      tokenResponse({ access_token: "ORG-AT2", refresh_token: "ORG-RT2", expires_in: 3600 }),
    );
    const refreshed = await refreshOrgClaudeToken(org.id);
    expect(refreshed).toBe("ORG-AT2");

    const row = await prisma.orgAiSettings.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(row.provider).toBe("sentinel-provider");
    expect(row.updatedById).toBe(sentinelUpdatedById);
    expect(openSecret((row.oauthAccessToken as { sealed: string }).sealed)).toBe("ORG-AT2");
  });
});
