// scripts/cutover/lib/revoke-core.test.ts
//
// Unit tests for the provider-side Google token-revoke core (Task 3). The fetch is mocked —
// NEVER hits real Google. Asserts: the exact endpoint + token are POSTed; 200 ⇒ revoked;
// 400 invalid_token ⇒ already-revoked (idempotent success); other ⇒ failed; a thrown fetch ⇒
// failed; the token is NEVER present in any result/detail; and the fake-Google endpoint is
// idempotent across calls + across persisted state (the CLI re-run case).

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  revokeOneToken,
  buildRevokeUrl,
  isRevokeSuccess,
  GOOGLE_REVOKE_ENDPOINT,
  type FetchLike,
} from "./revoke-core";
import { makeFakeGoogleFetch } from "./revoke-fake-google";

const TOKEN = "1//super-secret-refresh-token-value";

describe("revokeOneToken", () => {
  it("POSTs the Google revoke endpoint with the token as the query param", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => ({ status: 200, text: async () => "" }));
    const res = await revokeOneToken(TOKEN, fetchSpy);
    expect(res.status).toBe("revoked");
    expect(res.httpStatus).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${GOOGLE_REVOKE_ENDPOINT}?token=${encodeURIComponent(TOKEN)}`);
    expect(url).toBe(buildRevokeUrl(TOKEN));
    expect(init.method).toBe("POST");
  });

  it("treats 400 invalid_token as already-revoked (IDEMPOTENT success)", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => ({
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_token" }),
    }));
    const res = await revokeOneToken(TOKEN, fetchSpy);
    expect(res.status).toBe("already-revoked");
    expect(res.httpStatus).toBe(400);
    expect(res.detail).toBe("invalid_token");
    expect(isRevokeSuccess(res)).toBe(true);
  });

  it("treats any other non-200 as failed (retryable)", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => ({
      status: 503,
      text: async () => "service unavailable",
    }));
    const res = await revokeOneToken(TOKEN, fetchSpy);
    expect(res.status).toBe("failed");
    expect(res.httpStatus).toBe(503);
    expect(isRevokeSuccess(res)).toBe(false);
  });

  it("a thrown fetch ⇒ failed with httpStatus 0 (no token in the error)", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => {
      throw new Error("network down");
    });
    const res = await revokeOneToken(TOKEN, fetchSpy);
    expect(res.status).toBe("failed");
    expect(res.httpStatus).toBe(0);
    expect(res.detail).toBe("network down");
  });

  it("an empty/absent token ⇒ failed WITHOUT calling fetch", async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => ({ status: 200, text: async () => "" }));
    const res = await revokeOneToken("", fetchSpy);
    expect(res.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("NEVER returns the token in the result (revoked / already-revoked / failed)", async () => {
    const cases: FetchLike[] = [
      async () => ({ status: 200, text: async () => "" }),
      async () => ({ status: 400, text: async () => JSON.stringify({ error: "invalid_token" }) }),
      async () => ({ status: 500, text: async () => "boom" }),
    ];
    for (const f of cases) {
      const res = await revokeOneToken(TOKEN, f);
      expect(JSON.stringify(res)).not.toContain(TOKEN);
      expect(JSON.stringify(res)).not.toContain("super-secret");
    }
  });
});

describe("makeFakeGoogleFetch — models Google, idempotent", () => {
  it("first revoke ⇒ 200, second revoke of the SAME token ⇒ 400 invalid_token (in-process)", async () => {
    const fake = makeFakeGoogleFetch();
    const first = await revokeOneToken(TOKEN, fake);
    expect(first.status).toBe("revoked");
    const second = await revokeOneToken(TOKEN, fake);
    expect(second.status).toBe("already-revoked");
    expect(second.detail).toBe("invalid_token");
  });

  it("persists the already-revoked set across fetch instances via the state file (CLI re-run case)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "revoke-fake-"));
    const statePath = path.join(dir, "fake-google.json");
    // Process 1: fresh fake with state file → revoke succeeds.
    const fake1 = makeFakeGoogleFetch(statePath);
    expect((await revokeOneToken(TOKEN, fake1)).status).toBe("revoked");
    // Process 2: a NEW fake reading the SAME state file → the token is already revoked.
    const fake2 = makeFakeGoogleFetch(statePath);
    expect((await revokeOneToken(TOKEN, fake2)).status).toBe("already-revoked");
  });

  it("the fake never echoes the token in its responses", async () => {
    const fake = makeFakeGoogleFetch();
    const r1 = await fake(buildRevokeUrl(TOKEN), { method: "POST" });
    expect(await r1.text()).not.toContain(TOKEN);
    const r2 = await fake(buildRevokeUrl(TOKEN), { method: "POST" });
    expect(await r2.text()).not.toContain(TOKEN);
  });
});
