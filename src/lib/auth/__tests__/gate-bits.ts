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
import { Permission } from "@/lib/rbac/permissions";

const GATE_WITH_BIT = /\b(?:requirePermission|requireProjectManage|canAdministerProject|assertPermission)\([^;]*?Permission\.([A-Z_]+)/g;
const NEGATED_HAS = /!\s*hasPermission\([^)]*?Permission\.([A-Z_]+)/g;
const GATE_WITH_ACTION = /\b(?:requireAccess|requireProjectRead|assertProjectRead)\([^;]*?"([A-Z_]+)"/g;
/** `cond ? Permission.A : Permission.B` inside a gate: both sides are possible gates. */
const TERNARY = /\?\s*(?:Permission\.|")([A-Z_]+)"?\s*:\s*(?:Permission\.|")([A-Z_]+)/g;

/** Bits named by the gates in `code`. For a ternary gate both arms count. */
export function gateKeys(code: string): Set<string> {
  const keys = new Set<string>();
  for (const re of [GATE_WITH_BIT, NEGATED_HAS, GATE_WITH_ACTION]) for (const m of code.matchAll(re)) keys.add(m[1]);
  for (const gate of code.matchAll(/\b(?:requirePermission|requireProjectRead|requireAccess)\([^;]*?\?[^;]*?:[^;]*?\)/g)) {
    for (const m of gate[0].matchAll(TERNARY)) { keys.add(m[1]); keys.add(m[2]); }
  }
  return keys;
}

/** A handler's body plus the module's own helper functions it calls. */
export function handlerCode(src: string, method: string): string | null {
  const parts = src.split(/export async function (GET|POST|PUT|PATCH|DELETE)\b/);
  const i = parts.indexOf(method.toUpperCase());
  if (i <= 0) return null;
  let body = parts[i + 1];
  for (const m of parts[0].matchAll(/^(?:async )?function (\w+)\([\s\S]*?\n\}/gm)) {
    if (new RegExp(`\\b${m[1]}\\(`).test(body)) body += m[0];
  }
  return body;
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
