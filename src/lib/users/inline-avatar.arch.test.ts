import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * A file that selects `avatarUrl: true` must send it through `avatarSrc(` or
 * `avatarSrcs(` (src/lib/users/), or be listed below.
 *
 * Avatars are stored as `data:` URIs. Sent as is, every row that names a user
 * carries the image bytes, and base64 does not compress: a few users' avatars
 * were most of a 16 MB board payload. `avatarSrc` swaps them for a URL to the
 * avatar endpoint, which the browser fetches once and caches.
 *
 * File-level on purpose: it stops NEW select sites, not a regression inside a
 * file that already calls the helper. The routes' own payload tests guard that.
 *
 * Read from the syntax tree, so a comment or string that mentions either the
 * select or the helper does not count.
 */

const ROOTS = ["src/app/api", "src/lib"];

/** Never converted, with the reason. */
const PERMANENT: Record<string, string> = {
  "src/app/api/v1/orgs/[orgId]/users/[userId]/avatar/route.ts":
    "The avatar endpoint itself: it reads the stored value to serve the bytes.",
  "src/app/api/v1/me/route.ts":
    "The profile form echoes `avatarUrl` back on save, and `avatarUrlSchema` rejects a relative path.",
  "src/lib/auth/session.ts":
    "Feeds the current user's own profile, which is echoed back like /me.",
};

/**
 * Still inlining today. This list may only SHRINK: convert a file, then
 * delete its line. Never add one.
 */
const NOT_YET_CONVERTED = new Set([
  "src/app/api/v1/orgs/[orgId]/activity/route.ts",
  "src/app/api/v1/orgs/[orgId]/chat/channels/[channelId]/members/route.ts",
  "src/app/api/v1/orgs/[orgId]/chat/channels/[channelId]/route.ts",
  "src/app/api/v1/orgs/[orgId]/chat/channels/route.ts",
  "src/app/api/v1/orgs/[orgId]/export/json/route.ts",
  "src/app/api/v1/orgs/[orgId]/members/[memberId]/route.ts",
  "src/app/api/v1/orgs/[orgId]/projects/[projectId]/deliverables/[deliverableId]/route.ts",
  "src/app/api/v1/orgs/[orgId]/projects/[projectId]/deliverables/route.ts",
  "src/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/capacity/route.ts",
  "src/app/api/v1/orgs/[orgId]/projects/[projectId]/members/route.ts",
  "src/app/api/v1/orgs/[orgId]/projects/[projectId]/pm-comments/route.ts",
  "src/app/api/v1/orgs/[orgId]/projects/[projectId]/route.ts",
  "src/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/comments/route.ts",
  "src/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/merge/route.ts",
  "src/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route.ts",
  "src/app/api/v1/orgs/[orgId]/route.ts",
  "src/app/api/v1/orgs/[orgId]/work-items/facets/route.ts",
  "src/lib/cache/queries.ts",
  "src/lib/files/uploader.ts",
  "src/lib/members/add-member.server.ts",
  "src/lib/work-items/query/project.ts",
  "src/lib/work-items/read.server.ts",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Does the file select `avatarUrl: true`, and does it call `avatarSrc(`/`avatarSrcs(`? */
export function scan(fileName: string, text: string): { selects: boolean; converts: boolean } {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let selects = false;
  let converts = false;
  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyAssignment(n) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
      n.name.text === "avatarUrl" &&
      n.initializer.kind === ts.SyntaxKind.TrueKeyword
    ) selects = true;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      (n.expression.text === "avatarSrc" || n.expression.text === "avatarSrcs")
    ) converts = true;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { selects, converts };
}

describe("the scanner (controls)", () => {
  it("sees a select and a conversion in code", () => {
    expect(scan("a.ts", "f({ select: { avatarUrl: true } }); avatarSrc(o, u, s);")).toEqual({ selects: true, converts: true });
    expect(scan("a.ts", "await avatarSrcs(o, users)")).toEqual({ selects: false, converts: true });
  });

  it("ignores both in comments and strings, and keeps a URL string intact", () => {
    const text = [
      "// select: { avatarUrl: true } then avatarSrc(o, u, s)",
      "/* avatarSrcs(o, users) */",
      'const u = "https://x/avatarSrc(";',
      "f({ select: { avatarUrl: true } });",
    ].join("\n");
    expect(scan("a.ts", text)).toEqual({ selects: true, converts: false });
  });
});

describe("avatar selects go through avatarSrc", () => {
  const files = ROOTS.flatMap(sourceFiles).map((f) => f.split("\\").join("/")).sort();
  const scanned = files.map((f) => ({ f, ...scan(f, readFileSync(f, "utf8")) }));
  const inlining = scanned.filter((s) => s.selects && !s.converts).map((s) => s.f);

  it("no new file inlines avatar bytes", () => {
    const unexpected = inlining.filter((f) => !(f in PERMANENT) && !NOT_YET_CONVERTED.has(f));
    expect(
      unexpected,
      "This file selects `avatarUrl` and returns it as stored. Pass it through " +
        "`avatarSrc()` (one user) or `avatarSrcs()` (many rows) from src/lib/users/.",
    ).toEqual([]);
  });

  it("the not-yet-converted list only shrinks: drop a file once it is converted", () => {
    const stale = [...NOT_YET_CONVERTED].filter((f) => !inlining.includes(f));
    expect(stale).toEqual([]);
  });

  it("has no stale permanent exception", () => {
    expect(Object.keys(PERMANENT).filter((f) => !inlining.includes(f))).toEqual([]);
  });
});
