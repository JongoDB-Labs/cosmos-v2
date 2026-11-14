// A nested `user.memberships` read must say whether it wants removed members.
//
// Removal is a soft delete: the `org_members` row survives with `removedAt` set.
// src/lib/db/client.ts hides those rows from every direct `orgMember` read, but a
// nested relation load (`user.findUnique({ include: { memberships } })`) never
// reaches that hook, so it returns them. Unfiltered, the org list, the org
// switcher and the home page kept listing an org the person had left, and a
// password reset mailed as that org and wrote to its audit log.
//
// So every nested read either filters `removedAt` in its own block or is listed
// here, per file, with how many such reads it has and why it wants removed rows.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";

/** Files whose nested reads (or types) deliberately carry no `removedAt` filter. */
const ALLOWED: Record<string, { sites: number; reason: string }> = {
  "src/lib/auth/sso-provisioned-admin.ts": {
    sites: 1,
    reason:
      "INSTANCE ADMIN VIEW. Lists the orgs an IdP-made account is tied to, for an " +
      "instance admin deciding whether to clear the flag. It grants nothing, and it " +
      "matches auditOrgsFor beside it, which audits into removed orgs on purpose.",
  },
  "src/lib/auth/revoke-invitation.ts": {
    sites: 1,
    reason:
      "A `_count`. Revoking an invitation deletes the account only when nothing " +
      "else refers to it; a retained membership row is history in that org, so it " +
      "must still block the delete.",
  },
  "src/lib/auth/sender-org.ts": {
    sites: 1,
    reason: "A parameter type, not a query. Its callers filter (reset request route).",
  },
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** The text of the `{ ... }` block opening at `open`, or "" when unbalanced. */
function block(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}

type Site = { file: string; line: number; filtered: boolean };

function sites(file: string): Site[] {
  const src = readFileSync(file, "utf8");
  const out: Site[] = [];
  for (const m of src.matchAll(/\bmemberships\s*:\s*(\{|true\b)/g)) {
    const at = m.index ?? 0;
    const line = src.slice(0, at).split("\n").length;
    const filtered = m[1] === "{" && /\bremovedAt\b/.test(block(src, at + m[0].length - 1));
    out.push({ file: file.split("\\").join("/"), line, filtered });
  }
  return out;
}

describe("nested user.memberships reads filter removed members", () => {
  const all = walk(ROOT)
    .filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes("__tests__"))
    .flatMap(sites);
  const unfiltered = all.filter((s) => !s.filtered);

  it("finds the reads it is meant to police", () => {
    // Positive control: the org list, the dashboard shell and home page, and the
    // reset request and confirm routes all filter. A scan that finds none of them
    // is looking at the wrong text, and its empty result would prove nothing.
    expect(all.filter((s) => s.filtered).length).toBeGreaterThanOrEqual(7);
  });

  it("has no unfiltered read outside the allowlist", () => {
    const byFile = new Map<string, Site[]>();
    for (const s of unfiltered) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
    const unexpected = [...byFile].flatMap(([file, list]) =>
      list.length === (ALLOWED[file]?.sites ?? 0) ? [] : list.map((s) => `${s.file}:${s.line}`),
    );
    expect(
      unexpected,
      "A nested `memberships` read returns rows for orgs the person was removed " +
        "from. Add `where: { removedAt: null }` to it. If it really wants removed " +
        "rows, list the file in ALLOWED with its count and the reason.",
    ).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const stale = Object.keys(ALLOWED).filter((f) => !unfiltered.some((s) => s.file === f));
    expect(stale).toEqual([]);
  });
});
