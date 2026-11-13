import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { calleeName, keyOrSessionGates, parseSource } from "@/lib/auth/__tests__/gate-bits";
import { keyMay } from "@/lib/rbac/key-role";
import { Permission, RolePermissions, hasPermission, type PermissionKey } from "@/lib/rbac/permissions";
import { API_KEY_SCOPES, scopeMask } from "@/lib/auth/api-key-scopes";
import { mayManageOwnApiKeys, scopeGrantable } from "@/lib/auth/api-key-policy";

/**
 * A route that asks an API key for a different bit than a browser session must
 * also ask the key's creator for the session's bit: `keyMay` (key-role.ts).
 *
 * The bare substitution, `ctx.isApiKey ? Permission.A : Permission.B`, was
 * written while only admins held keys, and admins hold every bit. Once every
 * member could make a key, a role holding A but not B read through a key what
 * its own session is refused: a billing admin holds PROJECT_READ but not
 * ANALYTICS_READ, and its `read` key listed every project's KPIs.
 *
 * So this asserts the rule, not the call sites:
 *   1. no source file substitutes a bit for keys without keyMay, in any shape
 *      (a ternary, an if/else with or without braces, negated, or an early
 *      return), read from the syntax tree;
 *   2. every keyMay gate in the routes, for every role that may make a key and
 *      every scope it may put on one, lets a key through only when that role's
 *      session would get through, and only when the key's scopes carry the
 *      key's bit.
 */

const SRC = "src";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Calls that gate on a bit. keyMay and its kin are not here: they are the sanctioned form. */
const GATE_CALLS = new Set([
  "requirePermission",
  "requireProjectManage",
  "canAdministerProject",
  "assertPermission",
  "hasPermission",
  "requireAccess",
  "requireProjectRead",
  "assertProjectRead",
  "readableItemProjectId",
]);

/** A permission named outright: `Permission.X`, or a string that is a permission key. */
function literalBit(n: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Permission") return n.name.text;
  if (ts.isStringLiteralLike(n) && Object.hasOwn(Permission, n.text)) return n.text;
  return null;
}

/**
 * What a branch asks for: each gate call with the bits it names, and every bit
 * named anywhere in it (so `need = Permission.A` counts too). Empty when the
 * branch asks for nothing (a key-only refusal, or data chosen for a key).
 */
function asks(nodes: readonly ts.Node[]): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    const bit = literalBit(n);
    if (bit) out.add(`bit ${bit}`);
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && GATE_CALLS.has(name)) {
        const bits: string[] = [];
        const collect = (a: ts.Node) => {
          const b = literalBit(a);
          if (b) bits.push(b);
          ts.forEachChild(a, collect);
        };
        n.arguments.forEach(collect);
        out.add(`${name}(${bits.sort().join(",")})`);
      }
    }
    ts.forEachChild(n, visit);
  };
  nodes.forEach(visit);
  return out;
}

/** The condition reads `isApiKey` somewhere: `ctx.isApiKey`, `!r.ctx.isApiKey`, `a && ctx.isApiKey`. */
function testsIsApiKey(cond: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === "isApiKey") found = true;
    else ts.forEachChild(n, visit);
  };
  visit(cond);
  return found;
}

/** Leaves the function: the branch, or its last statement, returns or throws. */
function exits(stmt: ts.Statement): boolean {
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) return true;
  if (ts.isBlock(stmt)) return stmt.statements.length > 0 && exits(stmt.statements[stmt.statements.length - 1]);
  return false;
}

/** Both sides ask for something, and not the same thing. */
const differs = (a: Set<string>, b: Set<string>) =>
  a.size > 0 && b.size > 0 && (a.size !== b.size || [...a].some((x) => !b.has(x)));

/**
 * Every place in `code` that tests `isApiKey` and asks the two sides for
 * different bits without keyMay. Three shapes, read from the syntax tree, so
 * braces, negation, line breaks and comments don't matter:
 *   - `cond ? A : B`, where the arms name different bits or gates;
 *   - `if (cond) … else …`, with or without braces, where the branches do;
 *   - `if (cond) { …; return } …rest`, where the early-returning branch and
 *     the rest of its block do.
 * Both sides must ask for something: `if (ctx.isApiKey) return deny;` refuses
 * keys outright, and a ternary choosing data for a key names no bit.
 * Limit: a condition that reads isApiKey through another name
 * (`const k = ctx.isApiKey; if (k)`) is not seen.
 */
function substitutions(code: string, fileName = "snippet.ts"): string[] {
  const sf = parseSource(code, fileName);
  const found: string[] = [];
  const at = (n: ts.Node) => `${fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n: ts.Node) => {
    if (ts.isConditionalExpression(n) && testsIsApiKey(n.condition) && differs(asks([n.whenTrue]), asks([n.whenFalse]))) {
      found.push(at(n));
    }
    if (ts.isIfStatement(n) && testsIsApiKey(n.expression)) {
      if (n.elseStatement) {
        if (differs(asks([n.thenStatement]), asks([n.elseStatement]))) found.push(at(n));
      } else if (exits(n.thenStatement) && (ts.isBlock(n.parent) || ts.isSourceFile(n.parent))) {
        const siblings = n.parent.statements;
        const rest = siblings.slice(siblings.indexOf(n) + 1);
        if (differs(asks([n.thenStatement]), asks(rest))) found.push(at(n));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const files = sourceFiles(SRC);
const gates = files.flatMap((file) => keyOrSessionGates(readFileSync(file, "utf8"), file).map((g) => ({ file, ...g })));

describe("a key asked for a stand-in bit is also held to its creator's", () => {
  it("scanned the real tree and found the known gates", () => {
    // A move or rename must fail loudly rather than scan nothing and pass.
    expect(files.length).toBeGreaterThan(1000);
    expect(gates.length).toBeGreaterThanOrEqual(18);
    expect(gates).toContainEqual(expect.objectContaining({
      file: expect.stringContaining("kpis/route.ts"), key: "PROJECT_READ", session: "ANALYTICS_READ",
    }));
    expect(gates).toContainEqual(expect.objectContaining({
      file: expect.stringContaining("teams/digest/route.ts"), key: "RULES_RUN", session: "INTEGRATION_MANAGE",
    }));
  });

  it("the scan recognises every substitution shape (positive control)", () => {
    const shapes = {
      // The KPI route's old ternary, on one line and across lines.
      ternary: `requireProjectRead(ctx, projectId, ctx.isApiKey ? "PROJECT_READ" : "ANALYTICS_READ");`,
      multiline: `requirePermission(ctx, ctx.isApiKey\n  ? Permission.PROJECT_READ\n  : Permission.ORG_READ);`,
      // The Teams digest's old if/else.
      digest: `if (ctx.isApiKey) {\n  if (!hasPermission(ctx.permissions, Permission.RULES_RUN)) {\n    return deny;\n  }\n} else if (!hasPermission(ctx.permissions, Permission.INTEGRATION_MANAGE)) {\n  return deny;\n}`,
      braced: `if (ctx.isApiKey) { requirePermission(ctx, Permission.RULES_RUN); } else { requirePermission(ctx, Permission.INTEGRATION_MANAGE); }`,
      // Brace-less, and negated with the branches swapped.
      braceless: `if (ctx.isApiKey) requirePermission(ctx, Permission.PROJECT_READ);\nelse requirePermission(ctx, Permission.ORG_READ);`,
      negated: `if (!ctx.isApiKey) {\n  requirePermission(ctx, Permission.ORG_READ);\n} else {\n  requirePermission(ctx, Permission.PROJECT_READ);\n}`,
      // The bit chosen first, the gate run after.
      chosen: `let need; if (ctx.isApiKey) need = Permission.PROJECT_READ; else need = Permission.ORG_READ; requirePermission(ctx, need);`,
      // An early return in place of the else.
      early: `function f() {\n  if (!ctx.isApiKey) {\n    requirePermission(ctx, Permission.ORG_READ);\n    return;\n  }\n  requirePermission(ctx, Permission.PROJECT_READ);\n}`,
    };
    for (const [name, code] of Object.entries(shapes)) expect(substitutions(code), name).toHaveLength(1);

    const fine = {
      // A key-only refusal with no session branch is not a substitution.
      refusal: `if (r.ctx.isApiKey) {\n  return NextResponse.json({ error: "x" }, { status: 403 });\n}\nrequirePermission(ctx, Permission.ORG_READ);`,
      // A ternary choosing data for a key names no bit.
      data: `const readable = ctx.isApiKey ? await getReadableProjectIds(ctx) : null;`,
      // Both sides asking for the same thing.
      same: `if (ctx.isApiKey) requirePermission(ctx, Permission.ORG_READ); else requirePermission(ctx, Permission.ORG_READ);`,
      // keyMay is the sanctioned form, and its own module passes.
      keyRole: readFileSync("src/lib/rbac/key-role.ts", "utf8"),
      // A comment is not code.
      comment: `// requirePermission(ctx, ctx.isApiKey ? Permission.PROJECT_READ : Permission.ORG_READ);\n/* if (ctx.isApiKey) requirePermission(ctx, Permission.RULES_RUN); else requirePermission(ctx, Permission.ORG_READ); */`,
    };
    for (const [name, code] of Object.entries(fine)) expect(substitutions(code), name).toEqual([]);
  });

  it("reads key-or-session gates from code, not comments or strings", () => {
    expect(keyOrSessionGates(`requireKeyMay(ctx, "PROJECT_READ", "ORG_READ");`)).toEqual([{ key: "PROJECT_READ", session: "ORG_READ" }]);
    expect(keyOrSessionGates(`await requireProjectRead(ctx, id, { key: "PROJECT_READ", session: "ANALYTICS_READ" });`))
      .toEqual([{ key: "PROJECT_READ", session: "ANALYTICS_READ" }]);
    expect(keyOrSessionGates(`// requireKeyMay(ctx, "PROJECT_READ", "ORG_READ");\nconst s = 'keyMay(ctx, "PROJECT_READ", "ORG_READ")';`)).toEqual([]);
  });

  it("no source file substitutes a bit for keys without keyMay", () => {
    const offenders = files.flatMap((f) => substitutions(readFileSync(f, "utf8"), f));
    expect(offenders).toEqual([]);
  });

  // Every role that may make a key, as it is and with the key's bit granted on
  // top (a work role can grant one bit without the other).
  const owners = Object.entries(RolePermissions)
    .filter(([, p]) => mayManageOwnApiKeys(p))
    .flatMap(([role, p]) => [
      { label: role, perms: p },
      ...gates.map((g) => ({ label: `${role}+${g.key}`, perms: p | Permission[g.key as PermissionKey] })),
    ]);

  it("covers every role that may make a key (positive control)", () => {
    const roles = new Set(owners.map((o) => o.label.split("+")[0]));
    expect([...roles].sort()).toEqual(["ADMIN", "BILLING_ADMIN", "MEMBER", "OWNER", "VIEWER"]);
  });

  it("a key gets through a gate only when its creator's session would, and its scopes carry the key's bit", () => {
    const leaks: string[] = [];
    for (const g of gates) {
      const keyBit = g.key as PermissionKey;
      const sessionBit = g.session as PermissionKey;
      for (const owner of owners) {
        const grantable = API_KEY_SCOPES.filter((s) => scopeGrantable(owner.perms, s));
        for (const scopes of [...grantable.map((s) => [s]), [...grantable]]) {
          const ctx = { isApiKey: true, permissions: owner.perms & scopeMask(scopes), ownerPermissions: owner.perms };
          if (!keyMay(ctx, keyBit, sessionBit)) continue;
          if (!hasPermission(owner.perms, Permission[sessionBit])) {
            leaks.push(`${g.file}: ${owner.label} key [${scopes.join(",")}] passes without its creator's ${sessionBit}`);
          }
          if (!hasPermission(ctx.permissions, Permission[keyBit])) {
            leaks.push(`${g.file}: ${owner.label} key [${scopes.join(",")}] passes without ${keyBit} in its scopes`);
          }
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("is not vacuous: a billing admin's read key is refused KPIs, an admin's is let through", () => {
    const read = scopeMask(["read"]);
    const billing = RolePermissions.BILLING_ADMIN;
    const admin = RolePermissions.ADMIN;
    // The role table alone does NOT protect this gate: the billing admin holds the key bit.
    expect(hasPermission(billing, Permission.PROJECT_READ)).toBe(true);
    expect(hasPermission(billing, Permission.ANALYTICS_READ)).toBe(false);
    expect(keyMay({ isApiKey: true, permissions: billing & read, ownerPermissions: billing }, "PROJECT_READ", "ANALYTICS_READ")).toBe(false);
    expect(keyMay({ isApiKey: true, permissions: admin & read, ownerPermissions: admin }, "PROJECT_READ", "ANALYTICS_READ")).toBe(true);
  });

  it("every gate stays reachable: an admin's key with every scope gets through each one", () => {
    const admin = RolePermissions.ADMIN;
    const all = scopeMask([...API_KEY_SCOPES]);
    const unreachable = gates.filter(
      (g) => !keyMay({ isApiKey: true, permissions: admin & all, ownerPermissions: admin }, g.key as PermissionKey, g.session as PermissionKey),
    );
    expect(unreachable).toEqual([]);
  });

  it("a session is asked for the session's bit only", () => {
    for (const [role, perms] of Object.entries(RolePermissions)) {
      for (const g of gates) {
        expect(keyMay({ permissions: perms }, g.key as PermissionKey, g.session as PermissionKey), `${role} ${g.file}`)
          .toBe(hasPermission(perms, Permission[g.session as PermissionKey]));
      }
    }
  });
});
