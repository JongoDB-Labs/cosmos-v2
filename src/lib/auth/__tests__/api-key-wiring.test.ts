import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scopeMask } from "../api-key";
import { Permission, hasPermission } from "@/lib/rbac/permissions";

/**
 * API keys could be minted, listed in settings, and were rejected by every
 * endpoint in the product with a 401.
 *
 * `verifyApiKey` was complete and correct — hashing, timing-safe compare,
 * expiry, scope intersection, `lastUsed` — and **nothing called it**. A
 * repo-wide search for its name returned the module that defines it and the
 * test that covers it. Its unit tests passed the whole time, because a unit
 * test cannot see that no request ever reaches the unit.
 *
 * So there are two things to pin, and only the second is about behaviour:
 *   1. the key path is REACHABLE from the one place routes authenticate, and
 *   2. each scope grants what its name says.
 */

const SESSION_SRC = readFileSync(
  join(process.cwd(), "src/lib/auth/session.ts"),
  "utf8",
);

describe("the API-key path is wired into the auth entrypoint", () => {
  // `getAuthContext` is the single place every org-scoped route resolves an
  // actor. If the key path is not reachable from there, keys do not work —
  // which is exactly the state this shipped in.
  it("session.ts imports the key verifier", () => {
    expect(SESSION_SRC).toMatch(/import\s*\{[^}]*verifyApiKeyHeader[^}]*\}\s*from\s*["']\.\/api-key["']/);
  });

  it("getAuthContext calls it", () => {
    const body = SESSION_SRC.slice(SESSION_SRC.indexOf("export const getAuthContext"));
    expect(body).toContain("verifyApiKeyHeader(");
  });

  it("checks the key BEFORE requiring a session", () => {
    // Order matters: a bearer request carries no session cookie, so a
    // `getCurrentUser()` guard ahead of the key path would return null first
    // and the key would never be read — the bug, reintroduced.
    const body = SESSION_SRC.slice(SESSION_SRC.indexOf("export const getAuthContext"));
    expect(body.indexOf("verifyApiKeyHeader(")).toBeLessThan(
      body.indexOf("await getCurrentUser()"),
    );
  });

  it("still applies the IP allowlist to a key", () => {
    // A key must not be a way around an org's network restriction.
    const body = SESSION_SRC.slice(SESSION_SRC.indexOf("export const getAuthContext"));
    const keyBranch = body.slice(0, body.indexOf("await getCurrentUser()"));
    expect(keyBranch).toContain("ipAllowed");
  });
});

describe("a scope grants what its name says", () => {
  const read = scopeMask(["read"]);
  const write = scopeMask(["items:write"]);

  it("read can read items, projects AND their comments", () => {
    for (const p of [
      Permission.ITEM_READ,
      Permission.PROJECT_READ,
      // Without this a key could post a comment and be denied its own reply on
      // the way back out: "Access denied by policy" on a GET it had written to.
      Permission.COMMENT_READ,
    ]) {
      expect(hasPermission(read, p)).toBe(true);
    }
  });

  it("items:write can actually WRITE to an item, not only create one", () => {
    // The shipped mask had ITEM_CREATE and no ITEM_UPDATE — a key could file an
    // item and then never change its status, assignee or dates again.
    expect(hasPermission(write, Permission.ITEM_CREATE)).toBe(true);
    expect(hasPermission(write, Permission.ITEM_UPDATE)).toBe(true);
  });

  it("items:write can comment, and read the comments back", () => {
    expect(hasPermission(write, Permission.COMMENT_CREATE)).toBe(true);
    expect(hasPermission(write, Permission.COMMENT_READ)).toBe(true);
  });

  it("NEITHER scope can delete an item", () => {
    // Destroying work is a different decision from editing it. A key that needs
    // this should have to ask for it by name.
    expect(hasPermission(read, Permission.ITEM_DELETE)).toBe(false);
    expect(hasPermission(write, Permission.ITEM_DELETE)).toBe(false);
  });

  it("read cannot write — the negative control for the two above", () => {
    expect(hasPermission(read, Permission.ITEM_UPDATE)).toBe(false);
    expect(hasPermission(read, Permission.ITEM_CREATE)).toBe(false);
    expect(hasPermission(read, Permission.COMMENT_CREATE)).toBe(false);
  });

  it("an unknown scope grants nothing", () => {
    expect(scopeMask(["not-a-scope"])).toBe(0n);
    // …and cannot widen a real one.
    expect(scopeMask(["read", "not-a-scope"])).toBe(read);
  });
});
