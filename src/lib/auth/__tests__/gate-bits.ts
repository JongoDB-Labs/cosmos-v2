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
// plain if/else (not a ternary) are unioned, which over-states what a key
// needs. Such routes carry their own route tests (the Teams digest), and
// writes decided by a role helper are listed in helper-gated-writes.baseline.json.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Permission } from "@/lib/rbac/permissions";

const GATE_WITH_BIT = /\b(?:requirePermission|requireProjectManage|canAdministerProject|assertPermission)\([^;]*?Permission\.([A-Z_]+)/g;
const NEGATED_HAS = /!\s*hasPermission\([^)]*?Permission\.([A-Z_]+)/g;
// readableItemProjectId (lib/work-items/read.server) runs requireProjectRead with its action.
const GATE_WITH_ACTION = /\b(?:requireAccess|requireProjectRead|assertProjectRead|readableItemProjectId)\([^;]*?"([A-Z_]+)"/g;
/** `cond ? Permission.A : Permission.B` inside a gate: both sides are possible gates. */
const TERNARY = /\?\s*(?:Permission\.|")([A-Z_]+)"?\s*:\s*(?:Permission\.|")([A-Z_]+)/g;

/** cqlGate (lib/query/route.server) refuses a caller without the raw ITEM_READ bit. */
const CQL_GATE = /\bcqlGate\(/;

/** Bits named by the gates in `code`. For a ternary gate both arms count. */
export function gateKeys(code: string): Set<string> {
  const keys = new Set<string>();
  for (const re of [GATE_WITH_BIT, NEGATED_HAS, GATE_WITH_ACTION]) for (const m of code.matchAll(re)) keys.add(m[1]);
  if (CQL_GATE.test(code)) keys.add("ITEM_READ");
  for (const gate of code.matchAll(/\b(?:requirePermission|requireProjectRead|requireAccess)\([^;]*?\?[^;]*?:[^;]*?\)/g)) {
    for (const m of gate[0].matchAll(TERNARY)) { keys.add(m[1]); keys.add(m[2]); }
  }
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
 * Where an import specifier resolves, for the modules the scan follows: a
 * route's own helpers (`./_helpers`, `../shared`) and other route modules
 * (`@/app/...`, the forwards). Library gates (`@/lib/...`) are recognised by
 * name above instead, and following them would count their internals.
 */
function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith(".")) base = path.join(path.dirname(fromFile), spec);
  else if (spec.startsWith("@/app/")) base = path.join("src", spec.slice(2));
  else return null;
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
 * That is how ceremony routes gate (requireContributor in ./_helpers) and how
 * the work-item aliases forward to the project routes.
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
  let need = 0n;
  for (const k of keys) need |= (Permission as Record<string, bigint>)[k] ?? 0n;
  return need;
}
