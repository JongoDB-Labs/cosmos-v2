import { describe, expect, it } from "vitest";
import { keyMay, requireKeyMay } from "@/lib/rbac/key-role";
import { ForbiddenError } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";

// keyMay and requireKeyMay, on their own: the gate every key-or-session route
// calls (key-may.arch.test.ts proves the routes use it; this proves it gates).
// A key needs the key bit in its own (scope-masked) bits AND the session bit
// held by its creator; a session needs the session bit.

const KEY_BIT = "PROJECT_READ" as const;
const SESSION_BIT = "ANALYTICS_READ" as const;
const both = Permission.PROJECT_READ | Permission.ANALYTICS_READ;

const cases = [
  { name: "a key with the key bit, made by someone with the session bit", ctx: { isApiKey: true, permissions: Permission.PROJECT_READ, ownerPermissions: both }, ok: true },
  { name: "a key without the key bit in its scopes", ctx: { isApiKey: true, permissions: 0n, ownerPermissions: both }, ok: false },
  { name: "a key whose creator lacks the session bit", ctx: { isApiKey: true, permissions: Permission.PROJECT_READ, ownerPermissions: Permission.PROJECT_READ }, ok: false },
  { name: "a key holding the session bit itself but not the key bit", ctx: { isApiKey: true, permissions: Permission.ANALYTICS_READ, ownerPermissions: both }, ok: false },
  { name: "a key built without its creator's bits falls back to its own", ctx: { isApiKey: true, permissions: Permission.PROJECT_READ }, ok: false },
  { name: "a session with the session bit", ctx: { isApiKey: false, permissions: Permission.ANALYTICS_READ }, ok: true },
  { name: "a session with only the key bit", ctx: { isApiKey: false, permissions: Permission.PROJECT_READ }, ok: false },
];

describe("keyMay", () => {
  it.each(cases)("$name: $ok", ({ ctx, ok }) => {
    expect(keyMay(ctx, KEY_BIT, SESSION_BIT)).toBe(ok);
  });
});

describe("requireKeyMay", () => {
  it.each(cases.filter((c) => !c.ok))("throws Forbidden for $name", ({ ctx }) => {
    expect(() => requireKeyMay(ctx, KEY_BIT, SESSION_BIT)).toThrow(ForbiddenError);
  });

  it.each(cases.filter((c) => c.ok))("lets through $name", ({ ctx }) => {
    expect(() => requireKeyMay(ctx, KEY_BIT, SESSION_BIT)).not.toThrow();
  });
});
