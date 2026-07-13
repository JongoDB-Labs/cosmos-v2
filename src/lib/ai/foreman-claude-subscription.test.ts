// @vitest-environment node
//
// Foreman's OWN per-org Claude subscription — binds the shared
// claude-oauth-core.ts PKCE engine (task 2) to ForemanAiSettings (task 1),
// keyed by orgId, using the BROADER `CLAUDE_SCOPE_CODE` scope (adds Claude
// Code session access) instead of the org/user modules' narrower
// `CLAUDE_SCOPE_INFERENCE`. Mirrors claude-subscription.test.ts's
// adapter-specific coverage (exchange stamps provider/updatedById and the
// sealed token round-trips through getForemanClaudeToken via the REAL e2e
// DB; only the Claude token endpoint `fetch` is stubbed), plus this module's
// own differentiators:
//   1. initiate requests CLAUDE_SCOPE_CODE, not the inference-only scope.
//   2. disconnect takes only `orgId` — no `updatedById` (unlike
//      disconnectOrgClaude), per the brief's exact signature.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { prisma } from "@/lib/db/client";
import { openSecret } from "@/lib/crypto/vault";
import {
  initiateForemanClaudeOAuth,
  exchangeForemanClaudeCode,
  getForemanClaudeToken,
  getForemanClaudeStatus,
  disconnectForemanClaude,
} from "./foreman-claude-subscription";

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

describe("foreman-claude-subscription (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization
      .deleteMany({ where: { id: { in: cleanup.orgIds } } })
      .catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `org-foreman-claude-test ${stamp}`, slug: `org-foreman-claude-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    return { org, owner };
  }

  it("exchange stores a sealed token on foremanAiSettings; getForemanClaudeToken returns it", async () => {
    const { org, owner } = await makeOrg();
    vi.stubGlobal(
      "fetch",
      tokenResponse({ access_token: "FT", refresh_token: "FR", expires_in: 3600 }),
    );

    const r = await exchangeForemanClaudeCode(org.id, "CODE#S", "VER", "S", owner.id);

    expect(r.success).toBe(true);
    expect(await getForemanClaudeToken(org.id)).toBe("FT");

    // Adapter-specific stamping, mirroring claude-subscription.test.ts's pin
    // for makeOrgTokenStore: the explicit (user-initiated) exchange stamps
    // BOTH provider and updatedById, and the sealed access token is exactly
    // what round-trips back out.
    const row = await prisma.foremanAiSettings.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(row.provider).toBe("claude-oauth");
    expect(row.updatedById).toBe(owner.id);
    expect(openSecret((row.oauthAccessToken as { sealed: string }).sealed)).toBe("FT");
    expect(row.oauthExpiresAt).toBeInstanceOf(Date);
  });

  it("getForemanClaudeToken returns null when the org has no foreman connection", async () => {
    expect(await getForemanClaudeToken("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("initiateForemanClaudeOAuth requests the claude_code session scope (CLAUDE_SCOPE_CODE), not the narrower inference-only scope", () => {
    const { url, verifier, state } = initiateForemanClaudeOAuth();

    expect(url).toContain("scope=user%3Ainference+user%3Aprofile+user%3Asessions%3Aclaude_code");
    expect(verifier.length).toBeGreaterThan(0);
    expect(state.length).toBeGreaterThan(0);
  });

  it("getForemanClaudeStatus returns connected:false for an org with no connection", async () => {
    const { org } = await makeOrg();
    await expect(getForemanClaudeStatus(org.id)).resolves.toEqual({ connected: false });
  });

  it("disconnectForemanClaude nulls the oauth fields (single-arg signature — no updatedById)", async () => {
    const { org, owner } = await makeOrg();
    vi.stubGlobal(
      "fetch",
      tokenResponse({ access_token: "FT2", refresh_token: "FR2", expires_in: 3600 }),
    );
    await exchangeForemanClaudeCode(org.id, "CODE#S", "VER", "S", owner.id);

    await disconnectForemanClaude(org.id);

    const row = await prisma.foremanAiSettings.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(row.oauthAccessToken).toBeNull();
    expect(row.oauthRefreshToken).toBeNull();
    expect(row.oauthExpiresAt).toBeNull();
    expect(await getForemanClaudeToken(org.id)).toBeNull();
  });
});
