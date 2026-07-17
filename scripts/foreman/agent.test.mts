// Unit tests for runAgent's strict subscription gate. assertSubscription no longer
// looks at ~/.claude — the per-org Foreman token resolution (getForemanClaudeCreds)
// + the `!creds → throw NoForemanCredentialError` in runAgent are the auth source
// now — but it MUST still refuse any metered/cloud-billing env, verbatim.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/db/client";
import { openSecret } from "@/lib/crypto/vault";
import { materializeForemanHome, cleanupForemanHome } from "@/lib/foreman/foreman-creds";
import { persistForemanClaudeCreds } from "@/lib/ai/foreman-claude-subscription";
import { assertSubscription, NoForemanCredentialError, persistRotatedCredsIfChanged, resolveErrorSubtype } from "./agent.mjs";

describe("assertSubscription — metered refusal kept verbatim", () => {
  it("refuses when a metered / cloud-billing var is present", () => {
    expect(() => assertSubscription({ NODE_ENV: "test", ANTHROPIC_API_KEY: "x" })).toThrow(/ANTHROPIC_API_KEY/);
    for (const v of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) {
      expect(() => assertSubscription({ NODE_ENV: "test", [v]: "1" })).toThrow(new RegExp(v));
    }
  });

  it("does NOT throw on a clean allowlisted env — the ~/.claude existence check is gone", () => {
    // Previously this threw "no ~/.claude credentials"; the strict token resolver
    // replaces that check, so a clean env with no metered vars must pass the gate.
    expect(() =>
      assertSubscription({ PATH: "/usr/bin", HOME: "/tmp/foreman-home-x", NODE_ENV: "test" }),
    ).not.toThrow();
  });
});

describe("NoForemanCredentialError", () => {
  it("is an Error carrying the orgId in field + message", () => {
    const e = new NoForemanCredentialError("org-123");
    expect(e).toBeInstanceOf(Error);
    expect(e.orgId).toBe("org-123");
    expect(e.message).toContain("org-123");
  });
});

/* -------------------------------------------------------------------------- */
/*  persistRotatedCredsIfChanged — the runAgent `finally`'s write-back step,   */
/*  tested directly (real e2e DB + real vault; no SDK call involved at all).   */
/* -------------------------------------------------------------------------- */
describe("persistRotatedCredsIfChanged (e2e DB)", () => {
  const VAULT_KEY = crypto.randomBytes(32).toString("base64");
  const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;
  const cleanup: { orgIds: string[]; homes: string[] } = { orgIds: [], homes: [] };

  beforeAll(() => {
    process.env.SSO_VAULT_KEY = VAULT_KEY;
    delete process.env.SSO_VAULT_KEYS;
    delete process.env.SSO_VAULT_ACTIVE_KID;
  });

  afterAll(async () => {
    if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
    else process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
    await prisma.organization
      .deleteMany({ where: { id: { in: cleanup.orgIds } } })
      .catch(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of cleanup.homes.splice(0)) cleanupForemanHome(dir);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const org = await prisma.organization.create({
      data: { name: `org-agent-rotate-test ${stamp}`, slug: `org-agent-rotate-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    return org;
  }

  it("writes the rotated triple back onto ForemanAiSettings when the SDK rewrote the on-disk access token mid-run", async () => {
    // Only external `fetch` is mocked (and pinned to throw) — proving the
    // write-back path never touches the network; prisma + the vault are real.
    const fetchStub = vi.fn(async () => {
      throw new Error("unexpected network call");
    });
    vi.stubGlobal("fetch", fetchStub);

    const org = await makeOrg();
    // Inject creds A into a temp HOME, exactly as runAgent's materializeForemanHome does.
    const credsA = { accessToken: "AT-A", refreshToken: "RT-A", expiresAt: Date.now() + 3600_000 };
    await persistForemanClaudeCreds(org.id, credsA);
    const home = materializeForemanHome(credsA);
    cleanup.homes.push(home);

    // Simulate the SDK's own mid-run refresh: it rewrites .credentials.json in place
    // with a fresh triple (creds B) before runAgent's finally ever looks at it.
    const credsB = { accessToken: "AT-B", refreshToken: "RT-B", expiresAt: Date.now() + 7_200_000 };
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: credsB }),
    );

    // Run exactly the runAgent `finally` write-back step, in isolation.
    await persistRotatedCredsIfChanged(org.id, home, credsA);

    const row = await prisma.foremanAiSettings.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(openSecret((row.oauthAccessToken as { sealed: string }).sealed)).toBe(credsB.accessToken);
    expect(openSecret((row.oauthRefreshToken as { sealed: string }).sealed)).toBe(credsB.refreshToken);
    expect(row.oauthExpiresAt?.getTime()).toBe(credsB.expiresAt);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("is a no-op when the on-disk access token is unchanged (the common case — the SDK never refreshed)", async () => {
    const org = await makeOrg();
    const creds = { accessToken: "AT-SAME", refreshToken: "RT-SAME", expiresAt: Date.now() + 3600_000 };
    await persistForemanClaudeCreds(org.id, creds);
    const home = materializeForemanHome(creds);
    cleanup.homes.push(home);

    const upsertSpy = vi.spyOn(prisma.foremanAiSettings, "upsert");
    await persistRotatedCredsIfChanged(org.id, home, creds);
    expect(upsertSpy).not.toHaveBeenCalled();
    upsertSpy.mockRestore();
  });

  it("is best-effort — never throws, even when the credentials file is missing/unreadable", async () => {
    const org = await makeOrg();
    const creds = { accessToken: "AT-X", refreshToken: null, expiresAt: 0 };
    await expect(
      persistRotatedCredsIfChanged(org.id, "/nonexistent/foreman-home-dir", creds),
    ).resolves.toBeUndefined();
  });
});

describe("resolveErrorSubtype (COSMOS-131 max-turns detection)", () => {
  it("preserves an error_max_turns subtype the result message already captured", () => {
    // The real regression: the SDK yields a result (subtype set) then throws.
    expect(resolveErrorSubtype(false, "error_max_turns", new Error("boom"))).toBe("error_max_turns");
  });
  it("detects a turn overflow from the thrown text even if no subtype was captured", () => {
    const err = new Error("Claude Code returned an error result: Reached maximum number of turns (80)");
    expect(resolveErrorSubtype(false, null, err)).toBe("error_max_turns");
  });
  it("treats an abort as our timeout deadline regardless of prior subtype", () => {
    expect(resolveErrorSubtype(true, "error_max_turns", new Error("x"))).toBe("timeout");
  });
  it("falls back to error for an unknown throw with no prior subtype", () => {
    expect(resolveErrorSubtype(false, null, new Error("spawn ENOENT"))).toBe("error");
  });
});
