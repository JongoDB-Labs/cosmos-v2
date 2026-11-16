import { createHash } from "node:crypto";

/**
 * A stable, public name for a session, for lists and revoke links.
 *
 * A session's id used to BE its sign-in cookie value, and that cookie is
 * httpOnly so page script can't read it; sending the id in a JSON list undid
 * that. The id is now the row id (`sessionRowId` of the cookie), which is no
 * cookie either, but it is still the database's key, so lists send this
 * one-way hash of it instead and never the row id. Pass the row id. The id is
 * random and long, so the hash can't be reversed by guessing.
 *
 * One cookie does carry the row id, in another encoding: the connect cookie's
 * `h` (connect-sign-in.ts) is the same SHA-256 of the session cookie, as
 * base64url. It is httpOnly, and it is only ever set on the browser that holds
 * that session's own cookie.
 */
export function sessionHandle(sessionId: string): string {
  return createHash("sha256").update(`session-handle:${sessionId}`).digest("hex");
}
