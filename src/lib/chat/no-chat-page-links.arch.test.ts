import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Nothing in the product links to the old full-page chat any more.
 *
 * Chat lives in the docked drawer. `/<org>/chat` and `/<org>/chat/<id>` only
 * redirect now (see `legacy-chat-redirect.ts`), so a link that still targets
 * them costs every click a redirect and throws away the page the person was on.
 * The drawer form is `?chat=<id>` on any page, built by `chatDrawerHref`.
 *
 * Parsed with the TypeScript compiler, not matched by regex over the file: a
 * comment that explains the old path must not count, and a template literal
 * that builds the path from `${orgSlug}` and `${channelId}` must. Every string
 * and template literal is checked, which covers `href=`, `router.push`, a
 * notification's stored `url:` and a nav table's `href: "/chat"` alike.
 */

const ROOT = join(__dirname, "../../..");
const SRC = join(ROOT, "src");

function files(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Tests may quote old URLs on purpose (the redirect's own tests must). */
const isTest = (p: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || p.includes("/__tests__/");

/**
 * A page path whose first or second segment is `chat`: `/chat`, `/acme/chat`,
 * `/${orgSlug}/chat/${id}`, optionally behind an origin (`${origin}/${slug}/chat`).
 * Interpolations are normalised to `${}` before matching. The API lives under
 * `/api/v1/orgs/${orgId}/chat/…`, three segments deep, so it never matches.
 */
const CHAT_PAGE = /^(?:\$\{\})?\/(?:(?:\$\{\}|[^/?#$]+)\/)?chat(?:[/?#]|\$\{\}|$)/;

/**
 * Literals that match the shape but are not our page, by EXACT normalised
 * text, never by file: exempting a file would also exempt the next real link
 * written in it.
 */
const NOT_OUR_PAGE: Readonly<Record<string, string>> = {
  "${}/chat/completions": "a model provider's OpenAI-compatible endpoint (src/lib/ai/egress/provider.ts)",
};

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => "${}" + s.literal.text).join("");
  }
  return null;
}

/** Every literal in `source` that targets the old chat page, as "file:line text". */
export function chatPageTargets(
  source: string,
  fileName: string,
  allowed: Set<string> = new Set(),
): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const text = literalText(node);
    if (text !== null && CHAT_PAGE.test(text)) {
      if (text in NOT_OUR_PAGE) allowed.add(text);
      else found.push(`${fileName}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${text}`);
    }
    // A template expression's spans are visited for nested literals too.
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("the scanner itself", () => {
  it("finds every shape the old links took", () => {
    const src = [
      "router.push(`/${orgSlug}/chat/${channelId}`);",
      "const a = <Link href={`/${orgSlug}/chat`}>x</Link>;",
      'const b = <Link href="/acme/chat">x</Link>;',
      "const url = `/${input.orgSlug}/chat/${input.channelId}#msg-${input.messageId}`;",
      'const nav = { href: "/chat" };',
      "const abs = `${origin}/${slug}/chat/${id}`;",
    ].join("\n");
    expect(chatPageTargets(src, "fixture.tsx")).toHaveLength(6);
  });

  it("leaves the API, module paths, comments and the drawer form alone", () => {
    const src = [
      "// router.push(`/${orgSlug}/chat`) is what this used to do",
      "/* href=\"/acme/chat\" */",
      "fetch(`/api/v1/orgs/${orgId}/chat/channels/${channelId}/messages`);",
      'import { X } from "@/components/chat/composer";',
      'import { Y } from "./chat-panel";',
      "const drawer = chatDrawerHref(`/${orgSlug}`, { channelId });",
      'const p = "/acme/projects?chat=abc";',
      'const q = "/acme/chatter";',
    ].join("\n");
    expect(chatPageTargets(src, "fixture.tsx")).toEqual([]);
  });

  it("exempts a known non-page literal by its exact text only", () => {
    const allowed = new Set<string>();
    expect(chatPageTargets("const u = `${base}/chat/completions`;", "f.ts", allowed)).toEqual([]);
    expect(allowed.has("${}/chat/completions")).toBe(true);
    expect(chatPageTargets("const u = `${base}/chat/other`;", "f.ts")).toHaveLength(1);
  });
});

describe("no link in src/ targets the old full-page chat", () => {
  const all = files(SRC).filter((p) => !isTest(p));

  it("reads the whole tree, not a corner of it", () => {
    // A guard is only as wide as what it reads.
    expect(all.length).toBeGreaterThan(1000);
    const rel = new Set(all.map((p) => relative(ROOT, p)));
    for (const known of [
      "src/lib/chat/notifications.ts",
      "src/lib/mentions/registry.server.ts",
      "src/components/chat/new-dm-dialog.tsx",
      "src/components/search/command-palette.tsx",
      "src/components/layouts/topbar-nav.ts",
    ]) {
      expect(rel.has(known), known).toBe(true);
    }
  });

  it("finds none", () => {
    const allowed = new Set<string>();
    const offenders = all.flatMap((p) =>
      chatPageTargets(readFileSync(p, "utf8"), relative(ROOT, p), allowed),
    );
    expect(offenders).toEqual([]);
    // An exemption nothing uses any more is stale: delete it.
    expect([...allowed].sort()).toEqual(Object.keys(NOT_OUR_PAGE).sort());
  });
});
