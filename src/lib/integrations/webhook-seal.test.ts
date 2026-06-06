// @vitest-environment node
//
// Webhook HMAC-through-seal TRANSPARENCY (the load-bearing invariant of Task 2):
// for a given signing secret, the HMAC computed from the OPENED column value MUST
// be byte-identical to the HMAC computed from the raw plaintext secret — whether
// the column held the plaintext (legacy) or its sealed envelope. Existing webhook
// consumers verify `sha256=<hmac>`; sealing must NOT change a single byte.
//
// This mirrors exactly what webhook-dispatch.ts + the test route do:
//   signature = HMAC_SHA256( openField(hook.secret), body )
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

import { sealField, openField, openFieldWithHeal, isSealed } from "@/lib/crypto/field-seal";

const hmac = (secret: string, body: string) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

describe("webhook HMAC through seal/open is transparent", () => {
  const SECRET = "WHSEC-" + crypto.randomBytes(16).toString("hex");
  const body = JSON.stringify({ event: "test", timestamp: "2026-06-06T00:00:00.000Z", data: { x: 1 } });
  const expected = hmac(SECRET, body); // the signature consumers verify

  it("HMAC over the OPENED sealed secret equals HMAC over the raw plaintext secret", () => {
    const sealedColumn = sealField(SECRET); // what the DB now stores
    expect(sealedColumn).not.toBe(SECRET); // sealed at rest
    expect(isSealed(sealedColumn)).toBe(true);

    const opened = openField(sealedColumn); // what dispatch passes to createHmac
    expect(opened).toBe(SECRET); // transparent
    expect(hmac(opened, body)).toBe(expected); // byte-identical signature
  });

  it("a LEGACY plaintext secret column still produces the identical signature (transparent)", () => {
    // Pre-sealing row: the column holds the raw plaintext. openField returns it verbatim.
    const opened = openField(SECRET);
    expect(opened).toBe(SECRET);
    expect(hmac(opened, body)).toBe(expected);
  });

  it("dispatch self-heal: legacy plaintext opens to the right secret AND re-seals to sealed-at-rest", async () => {
    let persisted: string | undefined;
    // Simulates webhook-dispatch.ts: openFieldWithHeal with a re-persist callback.
    const opened = await openFieldWithHeal(SECRET, (sealed) => {
      persisted = sealed; // the route does prisma.webhook.update({ data: { secret: sealed } })
    });
    // Same signature this dispatch...
    expect(hmac(opened, body)).toBe(expected);
    // ...and the column is drained to a sealed envelope that still opens to the same secret.
    expect(persisted).toBeDefined();
    expect(isSealed(persisted!)).toBe(true);
    expect(openField(persisted!)).toBe(SECRET);
    expect(hmac(openField(persisted!), body)).toBe(expected);
  });
});
