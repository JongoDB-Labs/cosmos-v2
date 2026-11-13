import { createHash } from "node:crypto";

/**
 * A stable, public name for a session, for lists and revoke links.
 *
 * A session's id IS its sign-in cookie value, and that cookie is httpOnly so
 * page script can't read it. Sending the id in a JSON list undid that: any
 * script on the page could fetch it. This is a one-way hash of the id, so it
 * names the session without being usable as the cookie. The id is random and
 * long, so the hash can't be reversed by guessing.
 */
export function sessionHandle(sessionId: string): string {
  return createHash("sha256").update(`session-handle:${sessionId}`).digest("hex");
}
