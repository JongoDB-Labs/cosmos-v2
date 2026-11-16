// @vitest-environment node
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// One stored row per provider, kept in memory; the vault seals and opens for real.
const rows = vi.hoisted(() => new Map<string, { enabled: boolean; secretEnc: string }>());
vi.mock("@/lib/db/client", () => ({
  prisma: {
    authProviderConfig: {
      findUnique: async ({ where }: { where: { provider: string } }) => rows.get(where.provider) ?? null,
      upsert: async (a: { where: { provider: string }; create: { enabled: boolean; secretEnc: string } }) => {
        rows.set(a.where.provider, { enabled: a.create.enabled, secretEnc: a.create.secretEnc });
      },
    },
  },
}));

import { getProviderConfig, getProviderStatus, setProviderConfig } from "./provider-config";

const ORIGINAL = process.env.SSO_VAULT_KEY;
beforeAll(() => {
  process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");
  delete process.env.SSO_VAULT_KEYS;
  delete process.env.SSO_VAULT_ACTIVE_KID;
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL;
});
beforeEach(() => rows.clear());

const MS = { clientId: "00000000-0000-4000-8000-000000000001", clientSecret: "s3cret", tenant: "11111111-1111-4111-8111-111111111111" };

describe("Microsoft trusted domains in the provider settings", () => {
  it("stores the list and reads it back, with the status the admin form shows", async () => {
    await setProviderConfig("microsoft", { ...MS, trustedDomains: ["example.com"] });
    expect((await getProviderConfig("microsoft"))?.trustedDomains).toEqual(["example.com"]);
    expect((await getProviderStatus("microsoft")).trustedDomains).toEqual(["example.com"]);
  });

  it("keeps the list when a save leaves it out, the way a blank secret keeps the secret", async () => {
    await setProviderConfig("microsoft", { ...MS, trustedDomains: ["example.com"] });
    await setProviderConfig("microsoft", { clientId: MS.clientId, tenant: MS.tenant });
    expect((await getProviderConfig("microsoft"))?.trustedDomains).toEqual(["example.com"]);
  });

  it("clears the list when a save sends an empty one", async () => {
    await setProviderConfig("microsoft", { ...MS, trustedDomains: ["example.com"] });
    await setProviderConfig("microsoft", { clientId: MS.clientId, tenant: MS.tenant, trustedDomains: [] });
    expect((await getProviderConfig("microsoft"))?.trustedDomains).toEqual([]);
  });

  it("reads a row saved before the list existed as an empty list", async () => {
    await setProviderConfig("microsoft", MS);
    expect((await getProviderConfig("microsoft"))?.trustedDomains).toEqual([]);
  });
});
