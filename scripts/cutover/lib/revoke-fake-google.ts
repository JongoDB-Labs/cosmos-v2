// scripts/cutover/lib/revoke-fake-google.ts
//
// TEST-ONLY fake of Google's OAuth2 revoke endpoint, for the revoke-google-tokens.mjs
// `--fetch-impl test` path. It NEVER hits the network — it models Google's documented
// behavior so the synthetic acceptance can prove revoke + IDEMPOTENCY across separate CLI
// processes:
//
//   - first time a token is presented  ⇒ HTTP 200 (revoked); the token's HASH is recorded.
//   - any later time the SAME token is presented ⇒ HTTP 400 invalid_token (already-revoked),
//     exactly like a real already-revoked token — so a re-run of the CLI is idempotent.
//
// The "already revoked" set is persisted to a small JSON state file keyed by a sha256 of the
// token (NEVER the token itself), so idempotency holds across the separate processes a
// re-run uses. This module is imported ONLY by the CLI when --fetch-impl test is selected; the
// real path uses the global fetch.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { FetchLike } from "./revoke-core";

/** sha256 of the token (the state file key — never stores the token plaintext). */
function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Parse the `?token=` query value out of the revoke URL. */
function tokenFromUrl(url: string): string {
  const q = url.indexOf("?token=");
  if (q === -1) return "";
  return decodeURIComponent(url.slice(q + "?token=".length));
}

interface FakeState {
  /** sha256(token) → true for every token this fake has already "revoked". */
  revoked: Record<string, true>;
}

function load(statePath: string | undefined): FakeState {
  if (!statePath || !existsSync(statePath)) return { revoked: {} };
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.revoked && typeof parsed.revoked === "object") {
      return { revoked: parsed.revoked as Record<string, true> };
    }
  } catch {
    /* corrupt/empty state ⇒ start fresh */
  }
  return { revoked: {} };
}

function save(statePath: string | undefined, state: FakeState): void {
  if (!statePath) return;
  writeFileSync(statePath, JSON.stringify(state), "utf8");
}

/**
 * Build a TEST fetch that models Google's revoke endpoint. `statePath` (optional) persists
 * the already-revoked set across processes so a CLI re-run is idempotent; omit it for a
 * single in-process test (an in-memory set is then used).
 */
export function makeFakeGoogleFetch(statePath?: string): FetchLike {
  // In-memory mirror so multiple calls within ONE process are also idempotent even without
  // a state file (used by the unit test).
  const mem = load(statePath);
  return async (url: string) => {
    const token = tokenFromUrl(url);
    if (token.length === 0) {
      return { status: 400, text: async () => JSON.stringify({ error: "invalid_request" }) };
    }
    const key = tokenKey(token);
    if (mem.revoked[key]) {
      return { status: 400, text: async () => JSON.stringify({ error: "invalid_token" }) };
    }
    mem.revoked[key] = true;
    save(statePath, mem);
    return { status: 200, text: async () => "" };
  };
}
