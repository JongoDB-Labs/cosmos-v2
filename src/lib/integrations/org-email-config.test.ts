// @vitest-environment node
//
// Per-org transactional-email config resolution. Proves the vault seal→unseal
// round-trip (a key sealed with the REAL vault opens back to plaintext through
// getOrgEmailConfig), and that every not-usable state — disabled, missing row,
// no fromAddress, absent/corrupt key, or a DB error — degrades to null (never
// throws), so a broken per-org credential can never crash a send. Only the DB is
// mocked; sealSecret/openSecret run for real against a test SSO_VAULT_KEY.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { orgEmailSettings: { findUnique } } }));

import { sealSecret } from "@/lib/crypto/vault";
import { getOrgEmailConfig, hasSealedApiKey } from "./org-email-config";

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

beforeEach(() => findUnique.mockReset());

const ORG = "11111111-1111-1111-1111-111111111111";

function row(
  overrides: Partial<{
    provider: string;
    apiKey: unknown;
    fromAddress: string | null;
    enabled: boolean;
  }> = {},
) {
  return {
    provider: "resend",
    apiKey: { sealed: sealSecret("re_secret_key") },
    fromAddress: "Cosmos <invites@example.com>",
    enabled: true,
    ...overrides,
  };
}

describe("getOrgEmailConfig", () => {
  it("returns the unsealed config (seal→unseal round-trip) when enabled with a valid key + from", async () => {
    findUnique.mockResolvedValue(row());

    expect(await getOrgEmailConfig(ORG)).toEqual({
      apiKey: "re_secret_key",
      from: "Cosmos <invites@example.com>",
      provider: "resend",
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { orgId: ORG },
      select: { provider: true, apiKey: true, fromAddress: true, enabled: true },
    });
  });

  it("returns null when the row is disabled", async () => {
    findUnique.mockResolvedValue(row({ enabled: false }));
    expect(await getOrgEmailConfig(ORG)).toBeNull();
  });

  it("returns null when there is no row for the org", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getOrgEmailConfig(ORG)).toBeNull();
  });

  it("returns null when fromAddress is not set", async () => {
    findUnique.mockResolvedValue(row({ fromAddress: null }));
    expect(await getOrgEmailConfig(ORG)).toBeNull();
  });

  it("returns null when the API key is absent", async () => {
    findUnique.mockResolvedValue(row({ apiKey: null }));
    expect(await getOrgEmailConfig(ORG)).toBeNull();
  });

  it("returns null when the sealed key cannot be opened (corrupt/rotated/tampered)", async () => {
    findUnique.mockResolvedValue(row({ apiKey: { sealed: "not-a-sealed-value" } }));
    expect(await getOrgEmailConfig(ORG)).toBeNull();
  });

  it("returns null (never throws) when the DB read fails", async () => {
    // Realistic DB failure: the mock rejects, getOrgEmailConfig's try/catch degrades
    // to null. The outer .catch guard turns a (regression) throw into a distinct value
    // the assertion would reject, while keeping vitest v4's rejection tracker quiet.
    findUnique.mockImplementationOnce(() => Promise.reject(new Error("db unavailable")));

    const result = await getOrgEmailConfig(ORG).catch(() => "THREW");
    expect(result).toBeNull();
  });
});

describe("hasSealedApiKey", () => {
  it("is true for a { sealed: string } value", () => {
    expect(hasSealedApiKey({ sealed: sealSecret("x") })).toBe(true);
  });

  it("is false for null, undefined, or a non-sealed shape", () => {
    expect(hasSealedApiKey(null)).toBe(false);
    expect(hasSealedApiKey(undefined)).toBe(false);
    expect(hasSealedApiKey({})).toBe(false);
    expect(hasSealedApiKey({ sealed: 123 })).toBe(false);
  });
});
