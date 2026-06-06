// @vitest-environment node
//
// McpServer env/headers seal-at-rest: sealMcpJson seals JSON.stringify(map) into a
// vault envelope (the env_enc / headers_enc column value); the getMcpEnv/getMcpHeaders
// accessors open it back to the map. Empty/absent maps store NULL → open to {}.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";

const KEY = crypto.randomBytes(32).toString("base64");
const ORIGINAL = process.env.SSO_VAULT_KEY;

beforeAll(() => {
  process.env.SSO_VAULT_KEY = KEY;
  delete process.env.SSO_VAULT_KEYS;
  delete process.env.SSO_VAULT_ACTIVE_KID;
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL;
});

import { sealMcpJson, getMcpEnv, getMcpHeaders } from "@/lib/integrations/mcp-secrets";
import { isSealed } from "@/lib/crypto/field-seal";

describe("mcp env/headers seal-at-rest", () => {
  it("seals env into a vault envelope (not plaintext) and opens it back to the map", () => {
    // A distinctive secret value (won't appear by chance in base64 ciphertext).
    const SECRET = "TOKEN_VALUE_abc123XYZ_secret";
    const envEnc = sealMcpJson({ TOKEN: SECRET, REGION: "us" });
    expect(envEnc).not.toBeNull();
    expect(envEnc).not.toContain("TOKEN"); // the secret key/value is not visible at rest
    expect(envEnc).not.toContain(SECRET);
    expect(isSealed(envEnc!)).toBe(true);
    expect(getMcpEnv({ envEnc })).toEqual({ TOKEN: SECRET, REGION: "us" });
  });

  it("seals headers and opens them back via the accessor", () => {
    const headersEnc = sealMcpJson({ Authorization: "Bearer abc" });
    expect(headersEnc).not.toContain("Bearer");
    expect(isSealed(headersEnc!)).toBe(true);
    expect(getMcpHeaders({ headersEnc })).toEqual({ Authorization: "Bearer abc" });
  });

  it("an empty or absent map stores NULL and opens to {}", () => {
    expect(sealMcpJson({})).toBeNull();
    expect(sealMcpJson(null)).toBeNull();
    expect(sealMcpJson(undefined)).toBeNull();
    expect(getMcpEnv({ envEnc: null })).toEqual({});
    expect(getMcpHeaders({ headersEnc: null })).toEqual({});
  });
});
