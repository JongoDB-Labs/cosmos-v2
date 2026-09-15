import { describe, it, expect } from "vitest";
import { evaluateAccess } from "./engine";
import { requireAccess } from "./require-access";
import type { AuthContext } from "@/lib/rbac/check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Permission } from "@/lib/rbac/permissions";

/**
 * An API key must never inherit the OWNER break-glass.
 *
 * The break-glass exists so a human owner cannot be locked out of their own org
 * by a policy they authored. A key is not a human: it is a credential handed to
 * a script, and the entire reason to scope one is that its holder reaches LESS
 * than the person who minted it.
 *
 * This was not hypothetical. Measured against production on 2026-09-15 with a
 * real key: `DELETE /api/v1/orgs/{org}/work-items/{id}` returned 204 and the
 * item was gone, from a key whose scopes contained no ITEM_DELETE. The route
 * was correct — it called `requireAccess(ctx, "ITEM_DELETE")`. The engine
 * returned true before the permission mask was ever consulted, because the key
 * had been minted by an OWNER. `verifyApiKeyHeader` computes
 * `permissions & scopeMask` and the break-glass then discarded it.
 *
 * Since most keys are minted by an owner, that made scopes decorative for most
 * keys. These tests are specifically about an OWNER context: if they hold for
 * an owner they hold for everyone below.
 */

const ITEMS_WRITE =
  Permission.PROJECT_READ | Permission.ITEM_READ |
  Permission.ITEM_CREATE | Permission.ITEM_UPDATE | Permission.COMMENT_CREATE;

const base = {
  actorUserId: "u1",
  rules: [],
  resource: { projectId: "11111111-1111-1111-1111-111111111111" },
};

describe("an OWNER's API key is bound by its scope mask", () => {
  it("cannot DELETE when the mask has no ITEM_DELETE — the measured bug", () => {
    expect(
      evaluateAccess({
        ...base,
        effectivePermissions: ITEMS_WRITE,
        action: "ITEM_DELETE",
        isOwner: true,
        isApiKey: true,
      }),
    ).toBe(false);
  });

  it("can still do what its mask DOES grant", () => {
    // The negative control: if this were false the test above would pass for
    // the wrong reason — a key denied everything is not a fixed key.
    expect(
      evaluateAccess({
        ...base,
        effectivePermissions: ITEMS_WRITE,
        action: "ITEM_UPDATE",
        isOwner: true,
        isApiKey: true,
      }),
    ).toBe(true);
  });

  it("is denied an action absent from the mask even when the mask is broad", () => {
    // Everything except ITEM_DELETE. A key is never more than its scopes.
    const allButDelete = ~Permission.ITEM_DELETE;
    expect(
      evaluateAccess({
        ...base,
        effectivePermissions: allButDelete,
        action: "ITEM_DELETE",
        isOwner: true,
        isApiKey: true,
      }),
    ).toBe(false);
  });
});

describe("a PERSON's break-glass is untouched", () => {
  it("an OWNER with no permission bits still passes — that is the point of it", () => {
    // The break-glass must keep working for humans, or an owner can be locked
    // out of their own org by a policy they wrote. Narrowing it to nothing
    // would be a different bug, not a fix.
    expect(
      evaluateAccess({
        ...base,
        effectivePermissions: 0n,
        action: "ITEM_DELETE",
        isOwner: true,
      }),
    ).toBe(true);
  });

  it("an explicit isApiKey:false is treated as a person", () => {
    expect(
      evaluateAccess({
        ...base,
        effectivePermissions: 0n,
        action: "ITEM_DELETE",
        isOwner: true,
        isApiKey: false,
      }),
    ).toBe(true);
  });

  it("a non-owner is still bound by the mask, key or not", () => {
    for (const isApiKey of [true, false, undefined]) {
      expect(
        evaluateAccess({
          ...base,
          effectivePermissions: ITEMS_WRITE,
          action: "ITEM_DELETE",
          isOwner: false,
          isApiKey,
        }),
        `isApiKey=${String(isApiKey)}`,
      ).toBe(false);
    }
  });
});

describe("the ordering that caused this", () => {
  it("the mask is consulted for a key, not skipped", () => {
    // Pins the ORDER, not just the outcome. The original defect was a correct
    // mask computed and then discarded by a check that ran first; a future
    // reorder that puts an unconditional break-glass back on top would make
    // this pass only if the mask genuinely gates the decision.
    const denied = evaluateAccess({
      ...base, effectivePermissions: 0n,
      action: "ITEM_READ", isOwner: true, isApiKey: true,
    });
    const allowed = evaluateAccess({
      ...base, effectivePermissions: Permission.ITEM_READ,
      action: "ITEM_READ", isOwner: true, isApiKey: true,
    });
    expect([denied, allowed]).toEqual([false, true]);
  });
});

describe("requireAccess actually forwards the marker", () => {
  // The engine tests above call evaluateAccess directly, so they CANNOT see a
  // missing passthrough in requireAccess — verified by mutation: deleting
  // `isApiKey: ctx.isApiKey` from the call site left all of them green while
  // the fix was completely inert. That is the failure this block exists for.
  const keyCtx = (permissions: bigint): AuthContext =>
    ({
      userId: "u1",
      orgId: "o1",
      orgRole: "OWNER",
      permissions,
      basePermissions: permissions,
      abacRules: [],
      isApiKey: true,
    }) as AuthContext;

  it("denies an owner's KEY an action outside its mask", async () => {
    await expect(
      requireAccess(keyCtx(ITEMS_WRITE), "ITEM_DELETE"),
    ).rejects.toThrow(/Access denied/i);
  });

  it("still allows what the mask grants", async () => {
    // Negative control: a requireAccess that threw for everything would satisfy
    // the assertion above without the marker reaching the engine at all.
    await expect(
      requireAccess(keyCtx(ITEMS_WRITE), "ITEM_UPDATE"),
    ).resolves.toBeUndefined();
  });

  it("leaves a PERSON's owner break-glass intact", async () => {
    const personCtx = {
      userId: "u1", orgId: "o1", orgRole: "OWNER",
      permissions: 0n, basePermissions: 0n, abacRules: [],
    } as AuthContext;
    await expect(requireAccess(personCtx, "ITEM_DELETE")).resolves.toBeUndefined();
  });
});

describe("the key context declares itself", () => {
  // Third wire. The fix needs all three: the engine gates on the marker,
  // requireAccess forwards it, and verifyApiKeyHeader SETS it. Verified by
  // mutation that the two behavioural blocks above cannot see this one —
  // deleting `isApiKey: true` from api-key.ts left all 19 tests green while
  // every key silently regained the owner break-glass.
  //
  // Source-level because the behaviour needs a mocked Prisma and a mocked
  // permission loader, and a test that heavy tends to be deleted rather than
  // maintained. The property is narrow and the control below keeps it honest.
  const SRC = readFileSync(join(process.cwd(), "src/lib/auth/api-key.ts"), "utf8");

  it("verifyApiKeyHeader marks its context as an API key", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toContain("isApiKey: true");
  });

  it("and it sits in the returned context, beside the masked permissions", () => {
    // Narrower than "the string appears somewhere": it has to be in the object
    // that carries `permissions & mask`, which is the context being returned.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const ctx = code.slice(code.indexOf("permissions: eff.permissions & mask"));
    expect(ctx.slice(0, ctx.indexOf("};"))).toContain("isApiKey: true");
  });

  it("stripping comments leaves the code intact — the control", () => {
    // If the regexes ate the file, both assertions above would fail loudly
    // rather than pass vacuously; this states the expectation either way.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toContain("export async function verifyApiKeyHeader");
    expect(code).toContain("permissions: eff.permissions & mask");
  });
});
