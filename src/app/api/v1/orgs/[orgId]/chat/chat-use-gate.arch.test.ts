import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Every chat handler, read or write, refuses a caller without CHAT_USE: the
 * Chat page's own gate. Reads used to check only that the caller was signed in,
 * so a VIEWER or any API key could read public channels, search messages and
 * list channels by name. `chat-use-gate.test.ts` drives the writes and
 * `chat-reads.db.test.ts` the reads; this keeps a new handler from skipping it.
 *
 * Parsed with the TypeScript compiler, not matched as text: the gate must be a
 * real call that decides something (an `if` condition, or a
 * `requirePermission` statement, which throws), so a string or a comment that
 * spells the gate does not count.
 *
 * `roleCountsFor(ctx, Permission.CHAT_USE)` does not count: it says whether a
 * role counts, and is true for every browser session.
 */

const ROOT = "src/app/api/v1/orgs/[orgId]/chat";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Handlers gated on something else, and why that keeps chat closed to them. */
const EXEMPT: Record<string, string> = {
  "bots/route.ts PATCH": "configures the org's bots: ORG_MANAGE_SETTINGS, which no key scope grants",
};

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, acc);
    else if (entry.name === "route.ts") acc.push(full);
  }
  return acc;
}

const isExported = (node: ts.Node) =>
  ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const isName = (node: ts.Node | undefined, text: string) => !!node && ts.isIdentifier(node) && node.text === text;
const isAccess = (node: ts.Node | undefined, object: string, name: string) =>
  !!node && ts.isPropertyAccessExpression(node) && isName(node.expression, object) && node.name.text === name;

/** `mayUseChat(ctx)`, `hasPermission(ctx.permissions, Permission.CHAT_USE)` or `requirePermission(ctx, Permission.CHAT_USE)`. */
function gateKind(call: ts.CallExpression): "check" | "throws" | null {
  const [a, b] = call.arguments;
  if (isName(call.expression, "mayUseChat") && call.arguments.length === 1 && isName(a, "ctx")) return "check";
  if (isName(call.expression, "hasPermission") && isAccess(a, "ctx", "permissions") && isAccess(b, "Permission", "CHAT_USE")) return "check";
  if (isName(call.expression, "requirePermission") && isName(a, "ctx") && isAccess(b, "Permission", "CHAT_USE")) return "throws";
  return null;
}

/** Whether a gate call decides something: inside an `if` condition, or (one that throws) a statement of its own. */
function decides(call: ts.CallExpression, kind: "check" | "throws"): boolean {
  let node: ts.Node = call;
  // Climb through `!`, parentheses and `&&` / `||` to what holds the condition.
  while (
    ts.isPrefixUnaryExpression(node.parent) ||
    ts.isParenthesizedExpression(node.parent) ||
    (ts.isBinaryExpression(node.parent) &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.parent.operatorToken.kind))
  ) {
    node = node.parent;
  }
  if (ts.isIfStatement(node.parent) && node.parent.expression === node) return true;
  if (kind === "throws" && ts.isExpressionStatement(node.parent)) return true;
  // `await requirePermission(...)` as a statement.
  if (kind === "throws" && ts.isAwaitExpression(node.parent) && ts.isExpressionStatement(node.parent.parent)) return true;
  return false;
}

function hasGate(handler: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const kind = gateKind(node);
      if (kind && decides(node, kind)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(handler);
  return found;
}

/** `file METHOD` → its handler: an exported function, or an exported const holding one. */
function handlers(): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  for (const file of routeFiles(ROOT)) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const name = (method: string) => `${file.slice(ROOT.length + 1)} ${method}`;
    for (const stmt of sf.statements) {
      if (!isExported(stmt)) continue;
      if (ts.isFunctionDeclaration(stmt) && stmt.name && METHODS.has(stmt.name.text)) out.set(name(stmt.name.text), stmt);
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && METHODS.has(d.name.text) && d.initializer) out.set(name(d.name.text), d.initializer);
        }
      }
    }
  }
  return out;
}

describe("chat handlers", () => {
  const all = handlers();

  it("were found at all", () => {
    expect(all.size).toBeGreaterThan(30);
    expect(all.has("channels/[channelId]/messages/route.ts GET")).toBe(true);
  });

  it("each refuse a caller without CHAT_USE", () => {
    const open = [...all].filter(([name, node]) => !(name in EXEMPT) && !hasGate(node)).map(([name]) => name);
    expect(open).toEqual([]);
  });

  it("exempt only handlers that exist", () => {
    expect(Object.keys(EXEMPT).filter((name) => !all.has(name))).toEqual([]);
  });

  it("count only a call that decides, not text that spells one", () => {
    // Guards the guard: each of these must read as ungated.
    const parse = (body: string) => ts.createSourceFile("x.ts", `export async function GET() {\n${body}\n}`, ts.ScriptTarget.Latest, true).statements[0];
    expect(hasGate(parse(`if (!mayUseChat(ctx)) return deny();`))).toBe(true);
    expect(hasGate(parse(`requirePermission(ctx, Permission.CHAT_USE);`))).toBe(true);
    expect(hasGate(parse(`const ok = "mayUseChat(ctx)"; void ok;`))).toBe(false);
    expect(hasGate(parse(`// if (!mayUseChat(ctx)) return deny();`))).toBe(false);
    expect(hasGate(parse(`mayUseChat(ctx);`))).toBe(false);
    expect(hasGate(parse(`if (!hasPermission(ctx.permissions, Permission.CHAT_READ)) return deny();`))).toBe(false);
  });
});
