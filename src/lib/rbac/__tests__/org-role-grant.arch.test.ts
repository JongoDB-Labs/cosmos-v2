// @vitest-environment node
//
// Every function that grants access through an org membership, an invitation,
// a work role or a work-role assignment must run the grant ceiling
// (src/lib/rbac/grant-ceiling.ts). And every function that changes or removes
// a member, an invitation, a work role or a work-role assignment must run the
// ceiling on current role: the caller may change only access they could have
// granted.
//
// The ceiling was correct in one place and missing in another: changing a
// member's role refused OWNER from a non-owner, while adding a member did not,
// so the same escalation was reachable by adding instead of promoting. The next
// path that writes access has nothing else stopping it repeating that.
//
// Parsed with the TypeScript compiler, not matched by regex:
//  - A write belongs to its OUTERMOST enclosing function. An arrow-function
//    handler (`export const PUT = async () => ...`) is its own unit and is not
//    certified by a function above it, while a write inside a transaction
//    callback still belongs to the handler around it.
//  - A check counts only when its result can stop the write. An `assert*`
//    helper must be a statement of its own. A helper that returns a refusal,
//    or `isPermissionSubset`, must be the whole condition of an `if` (directly
//    or through a `const`, optionally negated) whose branch returns or throws.
//    A `return` inside a nested callback leaves only the callback, so there the
//    branch must throw. A result that is ignored, unused or ANDed with
//    anything else does not count.
//  - Comments and strings are not calls, so prose can't satisfy the guard.
//
// Exemptions are by file and function name, each with a reason, and a test
// fails when one goes stale. The fixtures at the end show the guard failing on
// each shape that slipped past its earlier, regex-based version.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SRC = join(process.cwd(), "src");

type Kind = "grant" | "change";
type Unit = { writes: Set<Kind>; checks: Set<Kind> };

/** Prisma model accessor → the methods that grant access, and the ones that change or remove it. */
const MODEL_WRITES: Record<string, Record<Kind, string[]>> = {
  orgMember: {
    grant: ["create", "createMany", "update", "updateMany", "upsert"],
    change: ["update", "updateMany", "delete", "deleteMany"],
  },
  invitation: {
    grant: ["create", "createMany", "update", "updateMany", "upsert"],
    change: ["delete", "deleteMany"],
  },
  orgMemberWorkRole: {
    grant: ["create", "createMany", "upsert"],
    change: ["delete", "deleteMany"],
  },
  workRole: {
    grant: ["create", "createMany", "update", "updateMany", "upsert"],
    change: ["update", "updateMany", "delete", "deleteMany"],
  },
};

/** A nested write inside another model's create or update, e.g. `members: { create: ... }`. */
const NESTED_RELATIONS = new Set(["members", "orgMembers", "workRoles", "invitations"]);
const NESTED_GRANTS = new Set(["create", "createMany", "connectOrCreate", "upsert"]);

/** Raw SQL against the same tables, through Prisma's raw query APIs. */
const RAW_APIS = new Set(["$executeRaw", "$executeRawUnsafe", "$queryRaw", "$queryRawUnsafe", "sql"]);
const RAW_WRITE =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(org_members|org_member_work_roles|invitations|work_roles)\b/gi;

/** Helpers that throw when refused: a statement of their own runs them. */
const ASSERTS: Record<string, Kind[]> = {
  assertCanGrantOrgRole: ["grant"],
  assertCanChangeCurrentAccess: ["change"],
};

/** Helpers whose result must decide an exit: a refusal message, or (isPermissionSubset) a pass. */
const REFUSALS: Record<string, Kind[]> = {
  orgRoleGrantRefusal: ["grant"],
  isPermissionSubset: ["grant"],
  currentAccessRefusal: ["change"],
  workRoleCeilingRefusal: ["grant", "change"],
};

const GRANT_ALLOWED: Record<string, string> = {
  "app/api/v1/orgs/[orgId]/members/[memberId]/route.ts#DELETE":
    "removal only sets removedAt; it grants nothing. It runs the ceiling on current role, pinned below",
  "app/api/v1/orgs/route.ts#POST":
    "creating an org makes its creator its owner; there is no granter above them",
  "lib/auth/sso.ts#completeSsoLogin":
    "the role comes from the org's IdP group mapping, capped at ADMIN; IdP connections are configured by operators, not through the app, so no request-time granter exists",
  "lib/auth/consume-invitations.ts#consumePendingInvitations":
    "applies the role chosen when the invitation was created or resent, and both of those run the ceiling",
  "lib/rbac/builtin-work-roles-seed.ts#seedBuiltinWorkRoles":
    "writes the platform's fixed catalog of built-in work roles into an org; it assigns them to nobody, and assigning one runs the ceiling",
};

const CHANGE_ALLOWED: Record<string, string> = {
  "app/api/v1/orgs/[orgId]/members/route.ts#POST":
    "reinstates a removed member, who holds nothing until then; the access they get back runs the grant ceiling above",
  "lib/auth/consume-invitations.ts#consumePendingInvitations":
    "the invitee accepting their own invitation; nobody else's access changes",
  "lib/auth/sso.ts#completeSsoLogin":
    "the person signing in consumes invitations addressed to their own verified email",
  "lib/internal/delete-user.ts#deleteUserAccount":
    "operator-only account deletion behind the internal admin gate, not an org role",
};

const ALLOWED: Record<Kind, Record<string, string>> = { grant: GRANT_ALLOWED, change: CHANGE_ALLOWED };

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name === "node_modules" || name === ".next" || name === "generated" || name === "__tests__") continue;
    const full = join(dir, name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const isFunctionLike = (n: ts.Node): boolean =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isConstructorDeclaration(n);

function textOf(name: ts.Node | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

function outermostFunction(node: ts.Node): ts.Node | null {
  let outer: ts.Node | null = null;
  for (let n = node.parent; n; n = n.parent) if (isFunctionLike(n)) outer = n;
  return outer;
}

function nearestFunction(node: ts.Node): ts.Node | null {
  for (let n = node.parent; n; n = n.parent) if (isFunctionLike(n)) return n;
  return null;
}

/** The name a function is known by: its own, or the variable or property it is assigned to. */
function functionName(fn: ts.Node): string {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) {
    const own = textOf(fn.name) ?? "default";
    const cls = fn.parent && ts.isClassLike(fn.parent) ? textOf(fn.parent.name) : null;
    return cls ? `${cls}.${own}` : own;
  }
  for (let n = fn.parent; n; n = n.parent) {
    if (ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n)) return textOf(n.name) ?? "<computed>";
    if (ts.isExportAssignment(n)) return "default";
    // Handler wrappers: `export const POST = withAuth(async () => ...)`.
    if (!(ts.isCallExpression(n) || ts.isParenthesizedExpression(n) || ts.isAsExpression(n) ||
          ts.isSatisfiesExpression(n) || ts.isAwaitExpression(n))) break;
  }
  return `<anonymous:${fn.getSourceFile().getLineAndCharacterOfPosition(fn.getStart()).line + 1}>`;
}

function unitOf(node: ts.Node): string {
  const outer = outermostFunction(node);
  return outer ? functionName(outer) : "<module>";
}

/** A lookup that ignores Object.prototype, so a call named `toString` or `constructor` is not a match. */
function own<T>(table: Record<string, T>, key: string | null): T | undefined {
  return key !== null && Object.hasOwn(table, key) ? table[key] : undefined;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** Does this branch return or throw, without counting a nested function's own returns? */
function exits(stmt: ts.Node, returnCounts: boolean): boolean {
  const hit = (n: ts.Node) => ts.isThrowStatement(n) || (returnCounts && ts.isReturnStatement(n));
  if (hit(stmt)) return true;
  let found = false;
  const visit = (n: ts.Node) => {
    if (found || isFunctionLike(n)) return;
    if (hit(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  ts.forEachChild(stmt, visit);
  return found;
}

/** Is `node` the whole condition (parenthesised or negated at most) of an `if` that exits the unit? */
function gatesExit(node: ts.Node): boolean {
  let e = node;
  while (
    e.parent &&
    (ts.isParenthesizedExpression(e.parent) ||
      (ts.isPrefixUnaryExpression(e.parent) && e.parent.operator === ts.SyntaxKind.ExclamationToken))
  ) e = e.parent;
  const stmt = e.parent;
  if (!stmt || !ts.isIfStatement(stmt) || stmt.expression !== e) return false;
  // A `return` leaves the unit only when the `if` sits directly in the unit's own function.
  const returnCounts = nearestFunction(stmt) === outermostFunction(stmt);
  return exits(stmt.thenStatement, returnCounts);
}

/** Is an `assert*` call here able to stop the unit? Not when a `catch` around it swallows the throw. */
function propagates(stmt: ts.Node): boolean {
  const outer = outermostFunction(stmt);
  for (let n: ts.Node = stmt; n.parent && n !== outer; n = n.parent) {
    const t = n.parent;
    if (ts.isTryStatement(t) && t.tryBlock === n && t.catchClause && !exits(t.catchClause.block, true)) return false;
  }
  return true;
}

/** Every unit in one source file that writes access, with the kinds of check it runs. */
function analyse(source: string, fileName: string): Map<string, Unit> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const units = new Map<string, Unit>();
  const unit = (id: string) => {
    if (!units.has(id)) units.set(id, { writes: new Set(), checks: new Set() });
    return units.get(id)!;
  };
  const held: { unit: string; name: string; kinds: Kind[] }[] = [];
  const tested = new Set<string>();

  const rawWrites = (n: ts.Node, text: string) => {
    for (const m of text.matchAll(RAW_WRITE)) {
      const verb = m[1].toUpperCase();
      if (!verb.startsWith("DELETE")) unit(unitOf(n)).writes.add("grant");
      if (!verb.startsWith("INSERT")) unit(unitOf(n)).writes.add("change");
    }
  };

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      // prisma.<model>.<method>(...) or tx.<model>.<method>(...)
      if (ts.isPropertyAccessExpression(n.expression)) {
        const writes = own(MODEL_WRITES, calleeName(n.expression.expression));
        for (const kind of ["grant", "change"] as const) {
          if (writes?.[kind].includes(n.expression.name.text)) unit(unitOf(n)).writes.add(kind);
        }
      }
      if (name && RAW_APIS.has(name)) for (const a of n.arguments) rawWrites(n, a.getText());
      const asserts = own(ASSERTS, name);
      if (asserts) {
        const stmt = ts.isAwaitExpression(n.parent) ? n.parent.parent : n.parent;
        if (stmt && ts.isExpressionStatement(stmt) && propagates(stmt)) {
          for (const k of asserts) unit(unitOf(n)).checks.add(k);
        }
      }
      const refusals = own(REFUSALS, name);
      if (refusals) {
        if (gatesExit(n)) for (const k of refusals) unit(unitOf(n)).checks.add(k);
        else if (ts.isVariableDeclaration(n.parent) && n.parent.initializer === n && ts.isIdentifier(n.parent.name)) {
          held.push({ unit: unitOf(n), name: n.parent.name.text, kinds: refusals });
        }
      }
    }
    if (ts.isTaggedTemplateExpression(n)) {
      const name = calleeName(n.tag);
      if (name && RAW_APIS.has(name)) rawWrites(n, n.template.getText());
    }
    if (ts.isPropertyAssignment(n) && NESTED_RELATIONS.has(textOf(n.name) ?? "") &&
        ts.isObjectLiteralExpression(n.initializer) &&
        n.initializer.properties.some((p) => NESTED_GRANTS.has(textOf(p.name) ?? ""))) {
      unit(unitOf(n)).writes.add("grant");
    }
    if (ts.isIdentifier(n) && gatesExit(n)) tested.add(`${unitOf(n)}\0${n.text}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);

  for (const h of held) {
    if (tested.has(`${h.unit}\0${h.name}`)) for (const k of h.kinds) unit(h.unit).checks.add(k);
  }
  for (const [id, u] of units) if (u.writes.size === 0) units.delete(id);
  return units;
}

/** `<file>#<unit>:<kind>` for each write whose unit lacks the matching check and has no exemption. */
function missing(file: string, units: Map<string, Unit>): string[] {
  const out: string[] = [];
  for (const [name, u] of units) {
    const id = `${file}#${name}`;
    for (const kind of u.writes) if (!u.checks.has(kind) && !ALLOWED[kind][id]) out.push(`${id}:${kind}`);
  }
  return out.sort();
}

describe("access writes run the ceiling", () => {
  const units = new Map<string, Unit>();
  let missed: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    const found = analyse(readFileSync(file, "utf8"), file);
    for (const [name, u] of found) units.set(`${rel}#${name}`, u);
    missed = missed.concat(missing(rel, found));
  }
  const ids = (kind: Kind) => [...units].filter(([, u]) => u.writes.has(kind)).map(([id]) => id);

  it("finds the known paths (positive control)", () => {
    for (const known of [
      "app/api/v1/orgs/[orgId]/members/route.ts#POST",
      "app/api/v1/orgs/[orgId]/members/[memberId]/route.ts#PUT",
      "app/api/v1/orgs/[orgId]/invitations/[invitationId]/route.ts#POST",
      "app/api/v1/orgs/[orgId]/members/[memberId]/work-roles/route.ts#PUT",
      "app/api/v1/orgs/[orgId]/work-roles/route.ts#POST",
      "app/api/v1/orgs/[orgId]/work-roles/[roleId]/route.ts#PUT",
      "app/api/v1/orgs/[orgId]/work-roles/[roleId]/members/route.ts#PUT",
      "lib/auth/create-invitation.ts#createOrgInvitation",
    ]) expect(ids("grant")).toContain(known);
    for (const known of [
      "app/api/v1/orgs/[orgId]/members/[memberId]/route.ts#PUT",
      "app/api/v1/orgs/[orgId]/members/[memberId]/route.ts#DELETE",
      "app/api/v1/orgs/[orgId]/invitations/[invitationId]/route.ts#DELETE",
      "app/api/v1/orgs/[orgId]/members/[memberId]/work-roles/route.ts#PUT",
      "app/api/v1/orgs/[orgId]/work-roles/[roleId]/members/route.ts#PUT",
      "app/api/v1/orgs/[orgId]/work-roles/[roleId]/route.ts#PUT",
      "app/api/v1/orgs/[orgId]/work-roles/[roleId]/route.ts#DELETE",
    ]) expect(ids("change")).toContain(known);
  });

  it("every function that grants or changes access runs the matching check, or is exempt by name", () => {
    expect(missed).toEqual([]);
  });

  it("every exemption still names a function that writes that kind of access", () => {
    for (const kind of ["grant", "change"] as const) {
      expect(Object.keys(ALLOWED[kind]).filter((id) => !units.get(id)?.writes.has(kind))).toEqual([]);
    }
  });
});

describe("the guard flags each shape that got past it before (fixtures)", () => {
  const check = (src: string) => missing("fixture.ts", analyse(src, "fixture.ts"));

  it("a work-role assignment with no ceiling", () => {
    expect(check(`export async function PUT() {
      await prisma.orgMemberWorkRole.createMany({ data: [{ orgMemberId, workRoleId }] });
    }`)).toEqual(["fixture.ts#PUT:grant"]);
  });

  it("creating a work role with no subset check", () => {
    expect(check(`export async function POST() {
      await prisma.workRole.create({ data: { orgId, name, grants } });
    }`)).toEqual(["fixture.ts#POST:grant"]);
  });

  it("an arrow-function handler is not certified by the function above it", () => {
    expect(check(`
      function guard(ctx, role) { assertCanGrantOrgRole(ctx, role); }
      export const PUT = async () => {
        await prisma.orgMember.update({ where: { id }, data: { role: "ADMIN" } });
      };`)).toEqual(["fixture.ts#PUT:change", "fixture.ts#PUT:grant"]);
  });

  it("a check whose result is ignored, unused, ANDed away, voided or not acted on", () => {
    for (const call of [
      `currentAccessRefusal(ctx, m.role);`,
      `const r = currentAccessRefusal(ctx, m.role);`,
      `const r = currentAccessRefusal(ctx, m.role); if (r && Date.now() < 0) return forbidden(r);`,
      `void currentAccessRefusal(ctx, m.role);`,
      `if (currentAccessRefusal(ctx, m.role)) { console.warn("over"); }`,
      `roles.forEach((r) => { if (currentAccessRefusal(ctx, r)) return; });`,
      `const x = assertCanChangeCurrentAccess;`,
      `try { assertCanChangeCurrentAccess(ctx, m.role); } catch { /* ignore */ }`,
    ]) {
      expect(check(`export async function DELETE() { ${call} await prisma.orgMember.delete({ where: { id } }); }`), call)
        .toEqual(["fixture.ts#DELETE:change"]);
    }
  });

  it("raw SQL and a nested create are writes", () => {
    expect(check("export async function f() { await prisma.$executeRaw`UPDATE org_members SET role = 'OWNER'`; }"))
      .toEqual(["fixture.ts#f:change", "fixture.ts#f:grant"]);
    expect(check(`export async function g() {
      await prisma.organization.update({ data: { members: { create: { userId, role: "OWNER" } } } });
    }`)).toEqual(["fixture.ts#g:grant"]);
  });

  it("a mention in a comment or a string is not a check", () => {
    expect(check(`export async function POST() {
      // assertCanGrantOrgRole(ctx, role);
      const note = "assertCanGrantOrgRole(ctx, role);";
      await prisma.invitation.create({ data: {} });
    }`)).toEqual(["fixture.ts#POST:grant"]);
  });

  it("passes a check that can stop the write (negative control)", () => {
    expect(check(`export async function DELETE() {
      const refusal = currentAccessRefusal(ctx, m.role, extra);
      if (refusal) return forbidden(refusal);
      await prisma.$transaction(async (tx) => { await tx.orgMember.update({ where: { id }, data: {} }); });
    }`)).toEqual(["fixture.ts#DELETE:grant"]);
    expect(check(`export const POST = withAuth(async () => {
      if (!isPermissionSubset(mask, ctx.basePermissions)) { return deny(); }
      await prisma.workRole.create({ data: {} });
    });`)).toEqual([]);
    expect(check(`export async function POST() {
      try {
        await assertCanGrantOrgRole(ctx, role);
        await prisma.invitation.create({ data: {} });
      } catch (e) {
        return handleApiError(e);
      }
    }`)).toEqual([]);
    expect(check(`export async function PUT() {
      await prisma.$transaction(async (tx) => {
        if (workRoleCeilingRefusal(ctx, mask)) throw new ForbiddenError("over");
        await tx.orgMemberWorkRole.deleteMany({});
      });
    }`)).toEqual([]);
  });
});
