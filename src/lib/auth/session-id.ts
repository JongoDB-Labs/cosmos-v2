import { createHash } from "node:crypto";

/**
 * The `Session` row id for a sign-in cookie's value: the SHA-256 of the token,
 * as lowercase hex.
 *
 * The cookie carries a random token (32 bytes, hex); the database keeps only
 * this hash of it. A copy of the sessions table (a backup, a read-only role, a
 * logged query) then holds nothing a browser could present as a cookie. The
 * token is random and long, so a plain hash is enough: there is nothing to
 * guess, so no salt and no slow hash.
 *
 * Every Session read, write, update and delete by id goes through here, which
 * `session-row-id.arch.test.ts` checks. Code that already holds a row id (a
 * `SessionUser.sessionId`, or an id read back from a row) passes that on as it
 * is. The migration that hashed the rows stored before this computes the same
 * value in SQL (`20261114180000_hash_session_ids`).
 */
export function sessionRowId(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
