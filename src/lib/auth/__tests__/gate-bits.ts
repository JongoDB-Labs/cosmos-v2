// The permission bits a route handler GATES on, read from its source: shared by
// scope-compat.test.ts and read-mask-writes.test.ts.
//
// Only bits inside a gate count: requirePermission / requireProjectManage
// (Permission.X), requireAccess / requireProjectRead (action keys), and a
// negated hasPermission. A plain hasPermission or a `permissions & X` test is
// usually an optional enrichment (show the money column when FINANCE_READ is
// held), and counting it as required would hide real reach: the SharePoint
// export POST looked unreachable for want of FINANCE_READ it never demands.
//
// Limits: a gate written as a positive hasPermission (`const ok = hasPermission(…)`)
// is invisible, and branches gated differently for keys and sessions with
// plain if/else (not keyMay or a ternary) are unioned, which over-states what a
// key needs. Such routes carry their own route tests (the Teams digest), and
// writes decided by a role helper are listed in helper-gated-writes.baseline.json.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { Permission } from "@/lib/rbac/permissions";

const GATE_WITH_BIT = /\b(?:requirePermission|requireProjectManage|canAdministerProject|assertPermission)\([^;]*?Permission\.([A-Z_]+)/g;
const NEGATED_HAS = /!\s*hasPermission\([^)]*?Permission\.([A-Z_]+)/g;
// readableItemProjectId (lib/work-items/read.server) runs requireProjectRead with its action.
const GATE_WITH_ACTION = /\b(?:requireAccess|requireProjectRead|assertProjectRead|readableItemProjectId)\([^;]*?"([A-Z_]+)"/g;
/** `cond ? Permission.A : Permission.B` inside a gate: both sides are possible gates. */
const TERNARY = /\?\s*(?:Permission\.|")([A-Z_]+)"?\s*:\s*(?:Permission\.|")([A-Z_]+)/g;
/** `code` parsed as TypeScript (TSX when `fileName` says so), with parent links. */
export function parseSource(code: string, fileName = "handler.ts"): ts.SourceFile {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
}

/** The name a call is made by: `f(…)` and `x.f(…)` both give "f". */
export function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/**
 * The key-or-session gates (rbac/key-role.ts): `keyMay(ctx, "A", "B")`,
 * `requireKeyMay(ctx, "A", "B")` and `requireProjectRead(ctx, id, { key: "A",
 * session: "B" })`. A is what a key's scopes must carry, B what a session (or
 * a key's creator) must hold. Both are possible gates, like a ternary's arms.
 *
 * Read from the syntax tree, so a call in a comment or a string is not a gate.
 */
export function keyOrSessionGates(code: string, fileName?: string): { key: string; session: string }[] {
  const out: { key: string; session: string }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && /^(?:keyMay|requireKeyMay)$/.test(calleeName(n) ?? "") && n.arguments.length === 3) {
      const [, key, session] = n.arguments;
      if (ts.isStringLiteralLike(key) && ts.isStringLiteralLike(session)) out.push({ key: key.text, session: session.text });
    }
    if (ts.isObjectLiteralExpression(n) && n.properties.length === 2) {
      const prop = (name: string) =>
        n.properties.find(
          (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
        )?.initializer;
      const key = prop("key");
      const session = prop("session");
      if (key && session && ts.isStringLiteralLike(key) && ts.isStringLiteralLike(session)) {
        out.push({ key: key.text, session: session.text });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(parseSource(code, fileName));
  return out;
}

/** cqlGate (lib/query/route.server) refuses a caller without the raw ITEM_READ bit. */
const CQL_GATE = /\bcqlGate\(/;
/**
 * lib/meetings/meeting-reader: meetingReader runs requirePermission(MEETING_READ),
 * and canReadMeeting / readableMeetingsWhere refuse a caller without the bit.
 */
const MEETING_READER = /\b(?:meetingReader|canReadMeeting|readableMeetingsWhere)\(/;

/** Bits named by the gates in `code`. For a ternary gate both arms count. */
export function gateKeys(code: string): Set<string> {
  const keys = new Set<string>();
  for (const re of [GATE_WITH_BIT, NEGATED_HAS, GATE_WITH_ACTION]) for (const m of code.matchAll(re)) keys.add(m[1]);
  if (CQL_GATE.test(code)) keys.add("ITEM_READ");
  if (MEETING_READER.test(code)) keys.add("MEETING_READ");
  for (const gate of code.matchAll(/\b(?:requirePermission|requireProjectRead|requireAccess)\([^;]*?\?[^;]*?:[^;]*?\)/g)) {
    for (const m of gate[0].matchAll(TERNARY)) { keys.add(m[1]); keys.add(m[2]); }
  }
  for (const g of keyOrSessionGates(code)) { keys.add(g.key); keys.add(g.session); }
  return keys;
}

const HANDLER = /^export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/;
/** Top-level functions in a module: `[export] [async] function name(...) {...}`. */
const FUNCTION = /^(?:export )?(?:async )?function (\w+)\b[\s\S]*?\n\}/gm;

/** One handler's own text: from its `export function` to the next top-level function. */
function handlerBody(src: string, method: string): string | null {
  for (const m of src.matchAll(FUNCTION)) {
    const h = HANDLER.exec(m[0]);
    if (h && h[1] === method.toUpperCase()) return m[0];
  }
  // `export { PATCH as PUT }` and the like.
  const alias = new RegExp(`export \\{\\s*(GET|POST|PUT|PATCH|DELETE) as ${method.toUpperCase()}\\s*\\}`).exec(src);
  return alias ? handlerBody(src, alias[1]) : null;
}

/**
 * Library modules that hold routes' gate-and-work, shared with the assistant's
 * tools (one gate, two entry points). A route that forwards to one has its gate
 * THERE, so the scan follows it exactly as it follows a route's `./_helpers`;
 * without that, each forwarding route would read as ungated. List a module only
 * when its exported functions are the routes' own handlers' bodies, never a
 * general library, whose internals would be counted as a route's gate.
 */
const ROUTE_SERVICES = new Set([
  "src/lib/intervals/ceremony.server.ts",
  "src/lib/boards/board-service.server.ts",
  "src/lib/projects/membership.server.ts",
  "src/lib/query/saved-view-service.server.ts",
]);

/**
 * Where an import specifier resolves, for the modules the scan follows: a
 * route's own helpers (`./_helpers`, `../shared`), other route modules
 * (`@/app/...`, the forwards) and the ROUTE_SERVICES above. Other library gates
 * (`@/lib/...`) are recognised by name above instead, and following them would
 * count their internals.
 */
function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith(".")) base = path.join(path.dirname(fromFile), spec);
  else if (spec.startsWith("@/app/")) base = path.join("src", spec.slice(2));
  else if (spec.startsWith("@/lib/")) {
    const file = path.join("src", `${spec.slice(2)}.ts`);
    return ROUTE_SERVICES.has(file) && existsSync(file) ? file : null;
  } else return null;
  for (const f of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (existsSync(f)) return f;
  return null;
}

/** The functions `code` calls that its module defines or imports from a followed module. */
function calledHelpers(code: string, src: string, file: string | undefined, depth: number, seen: Set<string>): string {
  let out = "";
  const called = (name: string) => new RegExp(`\\b${name}\\(`).test(code + out);
  // Local helpers, transitively (a helper that calls another).
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of src.matchAll(FUNCTION)) {
      if (HANDLER.test(m[0]) || seen.has(`${file}#${m[1]}`) || !called(m[1])) continue;
      seen.add(`${file}#${m[1]}`);
      out += "\n" + m[0];
      grew = true;
    }
  }
  if (!file || depth <= 0) return out;
  for (const imp of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/gm)) {
    const target = resolveImport(file, imp[2]);
    if (!target) continue;
    // `{ PUT as projectItemPut }`: the module exports `PUT`, the caller calls
    // `projectItemPut`. Match the export on the first name, the call on the second.
    const bindings = imp[1]
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith("type "))
      .map((n) => {
        const [exported, local = exported] = n.split(/\s+as\s+/);
        return { exported, local };
      });
    const used = bindings.filter((b) => called(b.local));
    if (!used.length) continue;
    const dep = readFileSync(target, "utf8");
    for (const { exported } of used) {
      if (seen.has(`${target}#${exported}`)) continue;
      // A forwarded route handler (`GET`, `PUT`, … including `export { PATCH
      // as PUT }`), or an ordinary exported helper.
      const fn = /^(?:GET|POST|PUT|PATCH|DELETE)$/.test(exported)
        ? handlerBody(dep, exported)
        : [...dep.matchAll(FUNCTION)].find((m) => /^export /.test(m[0]) && m[1] === exported)?.[0];
      if (!fn) continue;
      seen.add(`${target}#${exported}`);
      out += "\n" + fn + calledHelpers(fn, dep, target, depth - 1, seen);
    }
  }
  return out;
}

/**
 * A handler's body plus the helpers it calls: the module's own functions
 * (wherever they sit in the file) and, when `file` is given, functions it
 * imports from route-local modules and other route modules, two levels deep.
 * That is how ceremony routes gate (their ROUTE_SERVICES module) and how the
 * work-item aliases forward to the project routes.
 */
export function handlerCode(src: string, method: string, file?: string): string | null {
  const body = handlerBody(src, method);
  if (!body) return null;
  return body + calledHelpers(body, src, file, 2, new Set());
}

/**
 * The mask a caller must hold to pass every gate. For a ternary gate (session
 * vs key) the KEY arm is the one that applies, since only keys carry scopes;
 * pass `forKey: false` for the session arm.
 */
export function gateBits(code: string, { forKey = true } = {}): bigint {
  const keys = gateKeys(code);
  for (const gate of code.matchAll(/\b(?:requirePermission|requireProjectRead|requireAccess)\([^;]*?\?[^;]*?:[^;]*?\)/g)) {
    for (const m of gate[0].matchAll(TERNARY)) keys.delete(forKey ? m[2] : m[1]);
  }
  for (const g of keyOrSessionGates(code)) keys.delete(forKey ? g.session : g.key);
  let need = 0n;
  for (const k of keys) need |= (Permission as Record<string, bigint>)[k] ?? 0n;
  return need;
}
