import { describe, it, expect } from "vitest";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import { API_KEY_SCOPES } from "@/lib/auth/api-key-scopes";
import {
  API_KEY_LIMITS,
  expiryRefusal,
  latestExpiryWithoutManage,
  defaultExpiryDate,
  effectiveExpiry,
  keyInactiveReason,
  keyLapsedFor,
  KEY_INACTIVE_TEXT,
  MINT_REFUSAL_TEXT,
  mayHoldApiKeys,
  mayManageOwnApiKeys,
  managesAllApiKeys,
  refusedScopes,
  scopeGrantable,
  scopeRefusal,
  scopeVerdicts,
} from "@/lib/auth/api-key-policy";

const ROLES = ["OWNER", "ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER", "GUEST"] as const;
const perms = (role: (typeof ROLES)[number]) => RolePermissions[role];

describe("API_KEY_CREATE", () => {
  it("is bit 129 and no other permission shares it", () => {
    expect(Permission.API_KEY_CREATE).toBe(1n << 129n);
    const sharing = Object.entries(Permission).filter(([, bit]) => bit === Permission.API_KEY_CREATE);
    expect(sharing.map(([k]) => k)).toEqual(["API_KEY_CREATE"]);
  });

  it("every role but GUEST holds it; only OWNER and ADMIN also manage every key", () => {
    const holds = Object.fromEntries(ROLES.map((r) => [r, [
      (perms(r) & Permission.API_KEY_CREATE) !== 0n,
      managesAllApiKeys(perms(r)),
    ]]));
    expect(holds).toEqual({
      OWNER: [true, true],
      ADMIN: [true, true],
      BILLING_ADMIN: [true, false],
      MEMBER: [true, false],
      VIEWER: [true, false],
      GUEST: [false, false],
    });
  });
});

describe("mayHoldApiKeys: the one rule for minting AND for a key authenticating", () => {
  const on = { memberApiKeysEnabled: true };
  const off = { memberApiKeysEnabled: false };

  it("with the switch on, anyone holding CREATE or MANAGE", () => {
    expect(ROLES.filter((r) => mayHoldApiKeys(perms(r), on))).toEqual(["OWNER", "ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER"]);
  });

  it("with the switch off, only MANAGE holders", () => {
    expect(ROLES.filter((r) => mayHoldApiKeys(perms(r), off))).toEqual(["OWNER", "ADMIN"]);
  });

  it("MANAGE alone is enough, and CREATE alone only while the switch is on", () => {
    expect(mayHoldApiKeys(Permission.API_KEY_MANAGE, off)).toBe(true);
    expect(mayHoldApiKeys(Permission.API_KEY_CREATE, on)).toBe(true);
    expect(mayHoldApiKeys(Permission.API_KEY_CREATE, off)).toBe(false);
    expect(mayHoldApiKeys(0n, on)).toBe(false);
  });

  it("a key's masked permissions never qualify: no scope carries an API_KEY bit", async () => {
    const { scopeMask } = await import("@/lib/auth/api-key-scopes");
    const all = scopeMask([...API_KEY_SCOPES]);
    expect(all & (Permission.API_KEY_CREATE | Permission.API_KEY_MANAGE)).toBe(0n);
  });

  it("listing and revoking your own keys doesn't depend on the switch", () => {
    expect(ROLES.filter((r) => mayManageOwnApiKeys(perms(r)))).toEqual(["OWNER", "ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER"]);
  });
});

describe("keyInactiveReason: the one rule the verifier, the key list and minting share", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const made = new Date("2026-11-01T12:00:00Z");
  const IDP = "00000000-0000-4000-8000-0000000000aa";
  const OTHER_IDP = "00000000-0000-4000-8000-0000000000bb";
  const standing = (creatorPermissions: bigint | null, o: { on?: boolean; idp?: string | null } = {}) => ({
    creatorPermissions,
    policy: { memberApiKeysEnabled: o.on ?? true },
    requiredIdpConnId: o.idp ?? null,
  });
  const key = (o: { createdAt?: Date; expiresAt?: Date | null; idpConnId?: string | null } = {}) => ({
    createdAt: o.createdAt ?? made,
    expiresAt: o.expiresAt ?? null,
    idpConnId: o.idpConnId ?? null,
  });

  it("agrees with mayHoldApiKeys for every role, switch on and off, with no single sign-on", () => {
    for (const role of ROLES) {
      for (const on of [true, false]) {
        const works = keyInactiveReason(standing(perms(role), { on }), key(), now) === null;
        expect(works, `${role} on=${on}`).toBe(mayHoldApiKeys(perms(role), { memberApiKeysEnabled: on }));
      }
    }
  });

  it("names why: creator gone, expired, role, switch off, lapsed", () => {
    expect(keyInactiveReason(standing(null), key(), now)).toBe("creator_gone");
    expect(keyInactiveReason(standing(perms("MEMBER")), key({ expiresAt: new Date("2026-11-12T00:00:00Z") }), now)).toBe("expired");
    expect(keyInactiveReason(standing(perms("GUEST")), key(), now)).toBe("role");
    expect(keyInactiveReason(standing(perms("MEMBER"), { on: false }), key(), now)).toBe("switch_off");
    expect(keyInactiveReason(standing(perms("MEMBER")), key({ createdAt: new Date("2025-10-01T00:00:00Z") }), now)).toBe("lapsed");
    // Control: the same member's fresh key works.
    expect(keyInactiveReason(standing(perms("MEMBER")), key(), now)).toBeNull();
  });

  it("where single sign-on is required, a member's key works only if made through that IdP", () => {
    const sso = standing(perms("MEMBER"), { idp: IDP });
    expect(keyInactiveReason(sso, key({ idpConnId: IDP }), now)).toBeNull();
    // No recorded IdP fails closed, and so does another IdP's.
    expect(keyInactiveReason(sso, key({ idpConnId: null }), now)).toBe("sso");
    expect(keyInactiveReason(sso, key({ idpConnId: OTHER_IDP }), now)).toBe("sso");
    // Control: the same key with no requirement works, so turning it off restores it.
    expect(keyInactiveReason(standing(perms("MEMBER")), key({ idpConnId: null }), now)).toBeNull();
  });

  it("a creator who manages keys is not held to single sign-on, the switch or the 366 days", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      expect(keyInactiveReason(standing(perms(role), { idp: IDP, on: false }), key({ createdAt: new Date("2024-01-01T00:00:00Z") }), now)).toBeNull();
    }
    // But expiry and membership still bind them.
    expect(keyInactiveReason(standing(perms("ADMIN")), key({ expiresAt: new Date("2026-11-12T00:00:00Z") }), now)).toBe("expired");
    expect(keyInactiveReason(standing(null, { idp: IDP }), key({ idpConnId: IDP }), now)).toBe("creator_gone");
  });

  it("an owner whose API_KEY_MANAGE a restriction removes is held to the member rules", () => {
    const restricted = perms("OWNER") & ~Permission.API_KEY_MANAGE;
    expect(keyInactiveReason(standing(restricted, { idp: IDP }), key(), now)).toBe("sso");
    expect(keyInactiveReason(standing(restricted), key({ createdAt: new Date("2025-10-01T00:00:00Z") }), now)).toBe("lapsed");
  });

  it("every reason has words for the key list and for the create form", () => {
    for (const r of ["creator_gone", "expired", "role", "switch_off", "lapsed", "sso"] as const) {
      expect(KEY_INACTIVE_TEXT[r]).toMatch(/^Not active: /);
      expect(MINT_REFUSAL_TEXT[r].length).toBeGreaterThan(10);
    }
  });
});

describe("scopeGrantable, against the real role masks", () => {
  // The whole table, so any change to a role or a scope mask shows up here as
  // a reviewed diff rather than silently widening what a key may carry.
  const Y = true, N = false;
  const expected: Record<(typeof ROLES)[number], Record<(typeof API_KEY_SCOPES)[number], boolean>> = {
    OWNER:         { read: Y, "items:write": Y, "items:delete": Y, "planning:write": Y, "documents:write": Y, "time:read": Y, "time:write": Y, "members:read": Y, "webhooks:manage": Y, "audit:read": Y, "rules:run": Y },
    ADMIN:         { read: Y, "items:write": Y, "items:delete": Y, "planning:write": Y, "documents:write": Y, "time:read": Y, "time:write": Y, "members:read": Y, "webhooks:manage": Y, "audit:read": Y, "rules:run": Y },
    BILLING_ADMIN: { read: Y, "items:write": N, "items:delete": N, "planning:write": N, "documents:write": N, "time:read": Y, "time:write": N, "members:read": Y, "webhooks:manage": N, "audit:read": N, "rules:run": N },
    MEMBER:        { read: Y, "items:write": Y, "items:delete": N, "planning:write": Y, "documents:write": Y, "time:read": Y, "time:write": Y, "members:read": Y, "webhooks:manage": N, "audit:read": N, "rules:run": N },
    VIEWER:        { read: Y, "items:write": N, "items:delete": N, "planning:write": N, "documents:write": N, "time:read": Y, "time:write": N, "members:read": Y, "webhooks:manage": N, "audit:read": N, "rules:run": N },
    // GUEST can't mint at all (no API_KEY_CREATE); the row is here so a future
    // grant of the bit is reviewed against what it would let a key carry.
    GUEST:         { read: Y, "items:write": Y, "items:delete": N, "planning:write": N, "documents:write": N, "time:read": N, "time:write": N, "members:read": Y, "webhooks:manage": N, "audit:read": N, "rules:run": N },
  };

  it.each(ROLES)("%s", (role) => {
    const actual = Object.fromEntries(API_KEY_SCOPES.map((s) => [s, scopeGrantable(perms(role), s)]));
    expect(actual).toEqual(expected[role]);
  });

  it("the brief's member example holds", () => {
    const m = perms("MEMBER");
    for (const s of ["read", "items:write", "planning:write", "time:read", "time:write", "documents:write"] as const) {
      expect(scopeGrantable(m, s)).toBe(true);
    }
    expect(refusedScopes(m, ["read", "items:delete", "webhooks:manage", "audit:read", "rules:run"])).toEqual([
      "items:delete", "webhooks:manage", "audit:read", "rules:run",
    ]);
  });

  it("a scope whose only overlap with the person is a READ bit is refused", () => {
    // items:write includes PROJECT_READ, which every role holds; a VIEWER holds
    // nothing else of it, so the scope would give their key nothing it's named for.
    expect(perms("VIEWER") & Permission.PROJECT_READ).not.toBe(0n);
    expect(scopeGrantable(perms("VIEWER"), "items:write")).toBe(false);
  });

  it("time:write needs a bit that logs time: TIME_READ, which it also carries, is not enough", () => {
    expect(scopeGrantable(Permission.TIME_READ, "time:write")).toBe(false);
    expect(scopeGrantable(Permission.TIME_READ, "time:read")).toBe(true);
    expect(scopeGrantable(Permission.TIME_READ | Permission.TIME_CREATE, "time:write")).toBe(true);
    expect(scopeGrantable(Permission.TIME_READ | Permission.TIME_UPDATE, "time:write")).toBe(true);
  });

  it("`read` needs only one of its bits; nothing at all is refused", () => {
    expect(scopeGrantable(Permission.PROJECT_READ, "read")).toBe(true);
    expect(scopeGrantable(0n, "read")).toBe(false);
  });

  it("refusals give a short reason, and the form's verdicts come from the same function", () => {
    expect(scopeRefusal(perms("MEMBER"), "items:delete")).toBe("Your role can't delete work items.");
    expect(scopeRefusal(perms("MEMBER"), "items:write")).toBeNull();
    const verdicts = scopeVerdicts(perms("MEMBER"));
    expect(verdicts.map((v) => v.scope)).toEqual([...API_KEY_SCOPES]);
    for (const v of verdicts) expect(v.refusal).toBe(scopeRefusal(perms("MEMBER"), v.scope));
  });
});

describe("expiry", () => {
  const now = new Date("2026-03-01T12:00:00Z");
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

  it("someone without MANAGE must choose a date, in the future, at most 366 days ahead", () => {
    expect(expiryRefusal(null, false, now)).toBe("Choose when this key expires.");
    expect(expiryRefusal(days(-1), false, now)).toBe("Choose an expiry date in the future.");
    expect(expiryRefusal(now, false, now)).toBe("Choose an expiry date in the future.");
    expect(expiryRefusal(days(366), false, now)).toBeNull();
    expect(expiryRefusal(latestExpiryWithoutManage(now), false, now)).toBeNull();
    expect(expiryRefusal(new Date(latestExpiryWithoutManage(now).getTime() + 1), false, now)).toMatch(/at most 366 days/);
    expect(expiryRefusal(days(368), false, now)).toMatch(/at most 366 days/);
  });

  it("a MANAGE holder may choose no expiry or a later one, but not a past one", () => {
    expect(expiryRefusal(null, true, now)).toBeNull();
    expect(expiryRefusal(days(800), true, now)).toBeNull();
    expect(expiryRefusal(days(-1), true, now)).toBe("Choose an expiry date in the future.");
  });

  it("an unparseable date is refused", () => {
    expect(expiryRefusal(new Date("nope"), true, now)).toBe("That expiry date isn't valid.");
  });

  it("a key outlives its creator once they can't manage keys: at the end of the UTC day 366 days after it was made", () => {
    const member = RolePermissions.MEMBER;
    const admin = RolePermissions.ADMIN;
    const made = new Date("2025-03-01T12:00:00Z");
    expect(keyLapsedFor(member, made, new Date("2026-03-02T23:59:59.999Z"))).toBe(false);
    expect(keyLapsedFor(member, made, new Date("2026-03-03T00:00:00.000Z"))).toBe(true);
    // Someone who manages keys may hold one of any age.
    expect(keyLapsedFor(admin, made, new Date("2030-01-01T00:00:00Z"))).toBe(false);
    // A key made today is never cut short by the rule.
    expect(keyLapsedFor(member, now, days(366))).toBe(false);
  });

  it("the key list's expiry is when the key really stops, the same instant keyLapsedFor switches it off", () => {
    const member = RolePermissions.MEMBER;
    const admin = RolePermissions.ADMIN;
    const made = new Date("2025-03-01T10:00:00Z");
    const cap = effectiveExpiry(member, made, null)!;
    expect(cap.toISOString()).toBe("2026-03-02T23:59:59.999Z");
    // The list and the rule agree on the very instant.
    expect(keyLapsedFor(member, made, cap)).toBe(false);
    expect(keyLapsedFor(member, made, new Date(cap.getTime() + 1))).toBe(true);
    // An earlier expiry of its own stands; a later one is cut to the cap.
    const soon = new Date("2025-06-01T00:00:00Z");
    expect(effectiveExpiry(member, made, soon)).toEqual(soon);
    expect(effectiveExpiry(member, made, new Date("2027-01-01T00:00:00Z"))).toEqual(cap);
    // Someone who manages keys: exactly what was set, never-expiring included.
    expect(effectiveExpiry(admin, made, null)).toBeNull();
    expect(effectiveExpiry(admin, made, soon)).toEqual(soon);
  });

  it("the latest date is the end of the UTC day 366 days on; the form starts at 90 days", () => {
    expect(latestExpiryWithoutManage(now).toISOString()).toBe("2027-03-02T23:59:59.999Z");
    expect(defaultExpiryDate(now)).toBe("2026-05-30");
    expect(API_KEY_LIMITS).toEqual({ maxActivePerCreator: 20, maxDaysWithoutManage: 366, defaultDays: 90 });
  });
});
