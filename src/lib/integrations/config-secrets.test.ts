// @vitest-environment node
//
// splitConfigSecrets — the chokepoint that keeps a provider's secret config field
// (secret:true) OUT of plaintext Integration.config and routes it to the vault.
import { describe, it, expect } from "vitest";
import { splitConfigSecrets } from "./config-secrets";
import type { IntegrationProvider } from "./registry";

const github: IntegrationProvider = {
  slug: "github",
  name: "GitHub",
  description: "x",
  icon: "github",
  category: "dev",
  status: "available",
  connect: "config",
  authType: "api_key",
  configFields: [
    { key: "token", label: "PAT", type: "secret", required: true, secret: true },
    { key: "defaultOwner", label: "Owner", type: "text", required: false },
    { key: "defaultRepo", label: "Repo", type: "text", required: false },
  ],
};

describe("splitConfigSecrets", () => {
  it("routes the secret field to `secrets` and keeps it OUT of publicConfig", () => {
    const { publicConfig, secrets, hasSecrets } = splitConfigSecrets(github, {
      token: "GHTESTTOK",
      defaultOwner: "acme",
      defaultRepo: "cosmos",
    });
    expect(secrets).toEqual({ token: "GHTESTTOK" });
    expect(hasSecrets).toBe(true);
    expect(publicConfig).toEqual({ defaultOwner: "acme", defaultRepo: "cosmos" });
    // The token never appears in the plaintext config object.
    expect("token" in publicConfig).toBe(false);
    expect(JSON.stringify(publicConfig)).not.toContain("GHTESTTOK");
  });

  it("drops a blank secret (treated as 'unchanged') — not sealed, not persisted", () => {
    const { publicConfig, secrets, hasSecrets } = splitConfigSecrets(github, {
      token: "",
      defaultOwner: "acme",
    });
    expect(secrets).toEqual({});
    expect(hasSecrets).toBe(false);
    expect(publicConfig).toEqual({ defaultOwner: "acme" });
    expect("token" in publicConfig).toBe(false);
  });

  it("passes through providers with no configFields (backward-compatible)", () => {
    const { publicConfig, secrets, hasSecrets } = splitConfigSecrets(undefined, {
      foo: "bar",
    });
    expect(secrets).toEqual({});
    expect(hasSecrets).toBe(false);
    expect(publicConfig).toEqual({ foo: "bar" });
  });

  it("a field declared but NOT secret stays in publicConfig", () => {
    const { publicConfig, secrets } = splitConfigSecrets(github, { defaultOwner: "o" });
    expect(secrets).toEqual({});
    expect(publicConfig).toEqual({ defaultOwner: "o" });
  });
});
