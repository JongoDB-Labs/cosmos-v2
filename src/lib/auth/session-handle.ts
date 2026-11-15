import { createHash } from "node:crypto";

/**
 * A stable, public name for a session, for lists and revoke links.
 *
 * A session's id used to BE its sign-in cookie value, and that cookie is
 * httpOnly so page script can't read it; sending the id in a JSON list undid
 * that. The id is now the row id (`sessionRowId` of the cookie), which is no
 * cookie either, but it is still the database's key, so lists keep sending
 * this one-way hash of it instead. Pass the row id. The id is random and long,
 * so the hash can't be reversed by guessing.
 */
export function sessionHandle(sessionId: string): string {
  return createHash("sha256").update(`session-handle:${sessionId}`).digest("hex");
}
