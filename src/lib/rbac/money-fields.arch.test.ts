// @vitest-environment node
//
// Register money (a CLIN's ceiling, funding and burn, a change's cost impact, a
// contract's values) follows ONE rule, in src/lib/rbac/money-fields.ts. It used
// to ride on ANALYTICS_READ or CRM_READ, which every VIEWER holds, because each
// route, page, export and assistant tool decided for itself -- and the ones
// that decided nothing returned everything.
//
// So: every HANDLER that reads money must ask the rule. Per handler, not per
// file -- a file whose POST asks while its GET does not is exactly how the CRM
// contract list leaked. Parsed with the TypeScript compiler, so only real code
// counts: the words in a comment or a string are not reads.
//
// What "reads money" means here:
//  - a Prisma read of Clin, Contract or ChangeRequest with no `select` (the
//    whole row, money included), or with a `select` naming a money field from
//    MONEY_FIELDS; an aggregate over one;
//  - a `contract(s)`, `clins` or `changeRequests` relation pulled in by any
//    read, unless its own `select` leaves the money out;
//  - a call to a library function that does one of those (worked out from the
//    source, to a fixed point, so a new loader is caught without listing it).
// "Asks the rule" means calling a money-fields function, or a library function
// that does (`exportableContracts`, say).
//
// Handlers are route handlers (GET, POST, ...), the functions in pages and
// layouts, and the assistant's executors. A handler's own same-file helpers
// count as part of it.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import * as moneyFields from "./money-fields";
import { MONEY_FIELDS, type MoneyKind } from "./money-fields";

const ROOT = join(__dirname, "../../..");
const SRC = join(ROOT, "src");

/** Models whose rows carry money, by Prisma client property. */
const MODELS: Record<string, MoneyKind> = { clin: "clin", contract: "vendor", changeRequest: "change" };
/** Relation fields that pull those rows into another model's read. */
const RELATIONS: Record<string, MoneyKind> = { contract: "vendor", contracts: "vendor", clins: "clin", changeRequests: "change" };
/** Client methods that hand rows back. */
const READS = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow",
  "create", "update", "upsert", "createManyAndReturn", "updateManyAndReturn",
]);
const AGGREGATES = new Set(["aggregate", "groupBy"]);
const MONEY_SETS = Object.fromEntries(
  Object.entries(MONEY_FIELDS).map(([k, v]) => [k, new Set<string>(v)]),
) as Record<MoneyKind, Set<string>>;
const ROUTE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") sources(p, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function keyName(name: ts.PropertyName | ts.Identifier): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
}

/** An object literal's properties by key (spreads and computed keys are skipped). */
function props(obj: ts.ObjectLiteralExpression): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p)) {
      const k = keyName(p.name as ts.PropertyName);
      if (k) out.set(k, p.initializer);
    } else if (ts.isShorthandPropertyAssignment(p)) {
      out.set(p.name.text, p.name);
    }
  }
  return out;
}

const isFalse = (e: ts.Expression) => e.kind === ts.SyntaxKind.FalseKeyword;

/** The current file's top-level `const X = { ... }` objects, so a named select can be read. */
let CONSTS = new Map<string, ts.ObjectLiteralExpression>();

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isSatisfiesExpression(e) || ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** An object literal, or a same-file constant naming one; null when it can't be read. */
function literal(e: ts.Expression): ts.ObjectLiteralExpression | null {
  const u = unwrap(e);
  if (ts.isObjectLiteralExpression(u)) return u;
  if (ts.isIdentifier(u)) return CONSTS.get(u.text) ?? null;
  return null;
}

/** Does this `select` (or relation value) carry money of `kind`, or a money relation? */
function selectCarriesMoney(kind: MoneyKind | null, selExpr: ts.Expression): boolean {
  const sel = literal(selExpr);
  // Unreadable (imported, computed): on a money model it might carry money, so
  // it counts; under another model it can only matter through a relation.
  if (!sel) return kind !== null;
  for (const [k, v] of props(sel)) {
    if (k === "_count") continue; // how many, not which: no row comes back
    if (kind && MONEY_SETS[kind].has(k) && !isFalse(v)) return true;
    if (RELATIONS[k] && relationCarriesMoney(RELATIONS[k], v)) return true;
    const nested = RELATIONS[k] ? null : literal(v);
    if (nested) {
      // A non-money relation: its own select/include may still reach one.
      const inner = props(nested);
      for (const key of ["select", "include"] as const) {
        const e = inner.get(key);
        if (e && selectCarriesMoney(null, e)) return true;
      }
    }
  }
  return false;
}

/** A relation value: `true` is the whole row; an object is narrowed only by its own `select`. */
function relationCarriesMoney(kind: MoneyKind, v: ts.Expression): boolean {
  if (isFalse(v)) return false;
  const obj = literal(v);
  if (!obj) return true;
  const sel = props(obj).get("select");
  // `include` never narrows the row's own columns: only a `select` can.
  return sel ? selectCarriesMoney(kind, sel) : true;
}

/** A call whose result is thrown away (`await prisma.x.update(...)` as a statement) returns nothing to anyone. */
function discarded(call: ts.CallExpression): boolean {
  let n: ts.Node = call;
  while (n.parent && (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent))) n = n.parent;
  return !!n.parent && ts.isExpressionStatement(n.parent);
}

/** Is this call a Prisma read that hands money back? */
function isMoneyRead(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || discarded(call)) return false;
  const method = callee.name.text;
  const model = ts.isPropertyAccessExpression(callee.expression) ? callee.expression.name.text : null;
  const arg = call.arguments[0] ? literal(call.arguments[0]) : null;
  const args = arg ? props(arg) : null;

  if (model && MODELS[model] && READS.has(method)) {
    if (!args) return true; // no argument object we can read: the whole row
    const sel = args.get("select");
    return sel ? selectCarriesMoney(MODELS[model], sel) : true;
  }
  if (model && MODELS[model] && AGGREGATES.has(method) && args) {
    for (const agg of ["_sum", "_avg", "_min", "_max"]) {
      const e = args.get(agg);
      if (e && selectCarriesMoney(MODELS[model], e)) return true;
    }
    return false;
  }
  // Any other model's read that pulls a money relation in.
  if (READS.has(method) && args) {
    for (const key of ["include", "select"] as const) {
      const e = args.get(key);
      if (e && selectCarriesMoney(null, e)) return true;
    }
  }
  return false;
}

type Unit = { name: string; node: ts.Node; exported: boolean };

/** Top-level functions of a file: declarations and `const x = (...) => ...`. */
function units(sf: ts.SourceFile): Unit[] {
  const out: Unit[] = [];
  const exported = (n: ts.Node) =>
    !!(ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.body) {
      const isDefault = !!(ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Default);
      out.push({ name: st.name?.text ?? (isDefault ? "default" : "(anonymous)"), node: st, exported: exported(st) });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          out.push({ name: d.name.text, node: d.initializer, exported: exported(st) });
        }
      }
    }
  }
  return out;
}

/** Names called anywhere inside a node (plain calls and `x.name(...)` alike). */
function calledNames(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (ts.isIdentifier(c)) out.add(c.text);
      else if (ts.isPropertyAccessExpression(c)) out.add(c.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function hasMoneyRead(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && isMoneyRead(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

export type ParsedFile = { path: string; units: (Unit & { reads: boolean; calls: Set<string> })[]; includeMoneyTrue: number };

export function parse(source: string, path: string): ParsedFile {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  CONSTS = new Map();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      const init = d.initializer ? unwrap(d.initializer) : null;
      if (ts.isIdentifier(d.name) && init && ts.isObjectLiteralExpression(init)) CONSTS.set(d.name.text, init);
    }
  }
  let includeMoneyTrue = 0;
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && keyName(n.name as ts.PropertyName) === "includeMoney" && n.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      includeMoneyTrue++;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return {
    path,
    units: units(sf).map((u) => ({ ...u, reads: hasMoneyRead(u.node), calls: calledNames(u.node) })),
    includeMoneyTrue,
  };
}

/**
 * Within one file, a unit's closure over the same-file functions it calls:
 * does it (or a helper it calls) satisfy `own`, or call a name in `global`?
 */
function closure(file: ParsedFile, own: (u: ParsedFile["units"][number]) => boolean, global: Set<string>) {
  const byName = new Map(file.units.map((u) => [u.name, u]));
  const memo = new Map<string, boolean>();
  const test = (u: ParsedFile["units"][number], seen: Set<string>): boolean => {
    if (memo.has(u.name)) return memo.get(u.name)!;
    if (own(u)) return true;
    for (const c of u.calls) {
      if (global.has(c)) return true;
      const h = byName.get(c);
      if (h && h !== u && !seen.has(c) && test(h, new Set([...seen, c]))) return true;
    }
    return false;
  };
  return (u: ParsedFile["units"][number]) => {
    const r = test(u, new Set([u.name]));
    memo.set(u.name, r);
    return r;
  };
}

const MONEY_FIELDS_FILE = "src/lib/rbac/money-fields.ts";

/** The library's money sources and money gates, each grown to a fixed point. */
export function libraryFacts(files: ParsedFile[]) {
  const lib = files.filter((f) => f.path.startsWith("src/lib/") && f.path !== MONEY_FIELDS_FILE);
  // The rule itself: every function money-fields exports.
  const gates = new Set(Object.entries(moneyFields).filter(([, v]) => typeof v === "function").map(([k]) => k));
  const sources = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of lib) {
      const reads = closure(f, (u) => u.reads, sources);
      const asks = closure(f, () => false, gates);
      for (const u of f.units) {
        if (!u.exported) continue;
        if (!sources.has(u.name) && reads(u)) { sources.add(u.name); changed = true; }
        if (!gates.has(u.name) && asks(u)) { gates.add(u.name); changed = true; }
      }
    }
  }
  return { sources, gates };
}

const isRoute = (p: string) => p.startsWith("src/app/") && /\/route\.tsx?$/.test(p);
const isPage = (p: string) => p.startsWith("src/app/") && /\/(page|layout)\.tsx?$/.test(p);
const isExecutor = (p: string) => p.startsWith("src/lib/ai/executors/");

/** Every handler that reads money without asking the rule, as "file handler". */
export function ungated(files: ParsedFile[]): { checked: string[]; missing: string[] } {
  const { sources, gates } = libraryFacts(files);
  const checked: string[] = [];
  const missing: string[] = [];
  for (const f of files) {
    const handlers = f.units.filter((u) =>
      isRoute(f.path) ? u.exported && ROUTE_METHODS.has(u.name)
        : isPage(f.path) ? true
          : isExecutor(f.path) ? u.exported
            : false,
    );
    if (!handlers.length) continue;
    const reads = closure(f, (u) => u.reads, sources);
    const asks = closure(f, () => false, gates);
    for (const h of handlers) {
      if (!reads(h)) continue;
      checked.push(`${f.path} ${h.name}`);
      if (!asks(h)) missing.push(`${f.path} ${h.name}`);
    }
  }
  return { checked, missing };
}

const ALL = sources(SRC).map((p) => parse(readFileSync(p, "utf8"), relative(ROOT, p)));

/**
 * Handlers that read a money row and return none of it. Each one says why,
 * and each is re-checked: if it stops reading money, it must leave this list.
 */
const READS_BUT_RETURNS_NO_MONEY: Record<string, string> = {};

describe("the scanner (fixtures)", () => {
  const scan = (src: string) => ungated([parse(src, "src/app/api/x/route.ts")]);

  it("flags a whole-Contract list returned as is", () => {
    const r = scan(`export async function GET() {
      const rows = await prisma.contract.findMany({ where: {}, include: { partner: true } });
      return success(rows);
    }`);
    expect(r.missing).toEqual(["src/app/api/x/route.ts GET"]);
  });

  it("per handler: a POST that asks does not cover a GET that doesn't", () => {
    const r = scan(`import { moneyGate, projectMoney } from "@/lib/rbac/money-fields";
      export async function GET() { return success(await prisma.contract.findMany({})); }
      export async function POST() {
        const c = await prisma.contract.create({ data: {} });
        return success(projectMoney("vendor", c, (await moneyGate(ctx))(c.projectId)));
      }`);
    expect(r.missing).toEqual(["src/app/api/x/route.ts GET"]);
  });

  it("knows every money field, not only the contract ones", () => {
    for (const field of ["value", "burned", "remaining", "laborCost", "costImpact"]) {
      const model = field === "costImpact" ? "changeRequest" : "clin";
      expect(scan(`export async function GET() { return success(await prisma.${model}.findMany({ select: { id: true, ${field}: true } })); }`).missing, field).toHaveLength(1);
    }
    expect(scan(`export async function GET() { return success(await prisma.clin.findMany({ select: { id: true, code: true } })); }`).checked).toEqual([]);
  });

  it("follows relations: a partner with its contracts is money; with a narrow select it is not", () => {
    expect(scan(`export async function GET() { return success(await prisma.partner.findFirst({ include: { contracts: true } })); }`).missing).toHaveLength(1);
    expect(scan(`export async function GET() { return success(await prisma.partner.findFirst({ include: { contracts: { select: { id: true, title: true } } } })); }`).checked).toEqual([]);
  });

  it("reads a select kept in a same-file constant", () => {
    expect(scan(`const SEL = { id: true, value: true } as const;
      export async function GET() { return success(await prisma.contract.findMany({ select: SEL })); }`).missing).toHaveLength(1);
    expect(scan(`const SEL = { id: true, title: true } satisfies Prisma.ContractSelect;
      export async function GET() { return success(await prisma.contract.findMany({ select: SEL })); }`).checked).toEqual([]);
  });

  it("follows a same-file helper, and a library loader", () => {
    expect(scan(`async function load() { return prisma.clin.findMany({}); }
      export async function GET() { return success(await load()); }`).missing).toHaveLength(1);
    const lib = parse(`export async function loadThings() { return prisma.contract.findMany({}); }`, "src/lib/x/things.ts");
    const route = parse(`export async function GET() { return success(await loadThings()); }`, "src/app/api/y/route.ts");
    expect(ungated([lib, route]).missing).toEqual(["src/app/api/y/route.ts GET"]);
  });
});

describe("register money goes through money-fields, handler by handler", () => {
  const { checked, missing } = ungated(ALL);

  it("finds the handlers it is meant to check", () => {
    // Guards the guard: a parser that sees nothing passes over everything.
    for (const h of [
      "src/app/api/v1/orgs/[orgId]/contracts/route.ts GET",
      "src/app/api/v1/orgs/[orgId]/contracts/[contractId]/route.ts GET",
      "src/app/api/v1/orgs/[orgId]/partners/[partnerId]/route.ts GET",
      "src/app/api/v1/orgs/[orgId]/projects/[projectId]/clins/route.ts GET",
      "src/app/api/v1/orgs/[orgId]/projects/[projectId]/vendors/route.ts GET",
      "src/app/api/v1/orgs/[orgId]/export/json/route.ts GET",
    ]) {
      expect(checked, h).toContain(h);
    }
    expect(checked.length).toBeGreaterThan(20);
  });

  it("every handler that reads money asks the rule", () => {
    expect(missing.filter((h) => !(h in READS_BUT_RETURNS_NO_MONEY))).toEqual([]);
  });

  it("each exemption still reads money (or it should leave the list)", () => {
    for (const h of Object.keys(READS_BUT_RETURNS_NO_MONEY)) expect(missing, h).toContain(h);
  });

  it("no caller hardcodes includeMoney: true", () => {
    expect(ALL.filter((f) => f.includeMoneyTrue > 0).map((f) => f.path)).toEqual([]);
  });
});
