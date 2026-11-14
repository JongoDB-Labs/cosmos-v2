// A nested `user.memberships` read must say whether it wants removed members.
//
// Removal is a soft delete: the `org_members` row survives with `removedAt` set.
// src/lib/db/client.ts hides those rows from every direct `orgMember` read, but a
// nested relation load (`user.findUnique({ include: { memberships } })`) never
// reaches that hook, so it returns them. Unfiltered, the org list, the org
// switcher and the home page kept listing an org the person had left, and a
// password reset mailed as that org and wrote to its audit log.
//
// So every `memberships` key in src either filters `removedAt` itself or is
// listed here, per file, with how many such keys it has and why.
//
// What counts as filtered is deliberately narrow, because a scan can only see
// text: comments and string contents are blanked first; then the value must be
// an object literal whose OWN `where` (or, in a relation filter, `some`) is an
// object literal holding `removedAt` set to `null` or an object literal. A
// shorthand (`{ memberships }`), a variable (`memberships: args`), `true`, a
// quoted key, `removedAt: undefined` or a variable, and a `removedAt` nested any
// deeper all count as unfiltered.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";

/** Files whose `memberships` keys deliberately carry no filter this scan accepts. */
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
    reason: "A parameter type, not a query. Its one caller passes the filtered reads below.",
  },
  "src/app/api/auth/password/reset/request/route.ts": {
    sites: 1,
    reason:
      "The argument to resolveSenderOrg, built from this file's two reads, which " +
      "the scan accepts as filtered. A third read here would make the count 2.",
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

/**
 * The source with comments and string contents blanked to spaces, newlines kept
 * so line numbers survive. A string whose whole content is `memberships` is
 * kept, so a quoted key can be judged. Regex literals are skipped by the usual
 * rule: a `/` starts one where an expression may begin.
 */
function blank(src: string): string {
  const out = src.split("");
  const clear = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  let prev = ""; // last significant character outside comments and strings
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      clear(i, stop);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      clear(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (c !== "`" && src[j] === "\n") break;
        j++;
      }
      if (src.slice(i + 1, j) !== "memberships") clear(i + 1, j);
      i = j + 1;
      prev = c;
    } else if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      clear(i + 1, j);
      i = j + 1;
      prev = "/";
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out.join("");
}

/** End index (exclusive) of the bracketed block opening at `open`, or -1. */
function blockEnd(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if ("{[(".includes(s[i])) depth++;
    else if ("}])".includes(s[i]) && --depth === 0) return i + 1;
  }
  return -1;
}

/** The keys at the top level of the object literal `{ ... }` and where each value starts. */
function topLevelKeys(block: string): { key: string; at: number }[] {
  const keys: { key: string; at: number }[] = [];
  let depth = 0;
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if ("{[(".includes(c)) {
      depth++;
      continue;
    }
    if ("}])".includes(c)) {
      depth--;
      continue;
    }
    if (depth !== 1) continue;
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(block.slice(i));
    if (m && /[{,]\s*$/.test(block.slice(0, i))) {
      keys.push({ key: m[1], at: i + m[0].length });
      i += m[0].length - 1;
    }
  }
  return keys;
}

const valueAt = (s: string, at: number) => s.slice(at).replace(/^\s+/, "");

/** Whether the object literal `block` filters `removedAt` in its own `where` or `some`. */
function filtersRemoved(block: string): boolean {
  for (const k of topLevelKeys(block)) {
    if (k.key !== "where" && k.key !== "some") continue;
    const v = valueAt(block, k.at);
    if (!v.startsWith("{")) continue;
    const inner = v.slice(0, blockEnd(v, 0));
    for (const r of topLevelKeys(inner)) {
      if (r.key !== "removedAt") continue;
      const rv = valueAt(inner, r.at);
      if (/^null\b/.test(rv) || rv.startsWith("{")) return true;
    }
  }
  return false;
}

type Site = { line: number; filtered: boolean; shape: string };

/** Every `memberships` key in `src`, judged. */
function judge(src: string): Site[] {
  const s = blank(src);
  const out: Site[] = [];
  const line = (at: number) => s.slice(0, at).split("\n").length;
  // A quoted key: never accepted, whatever follows.
  for (const m of s.matchAll(/(["'])memberships\1\s*:/g)) {
    out.push({ line: line(m.index ?? 0), filtered: false, shape: "quoted key" });
  }
  // A shorthand property, `{ memberships }` or `{ a, memberships, b }`.
  for (const m of s.matchAll(/(?<=[{,]\s*)memberships(?=\s*[,}])/g)) {
    out.push({ line: line(m.index ?? 0), filtered: false, shape: "shorthand" });
  }
  // A plain key: judge its value.
  for (const m of s.matchAll(/(?<![.\w$"'])memberships\s*:(?!:)/g)) {
    const at = (m.index ?? 0) + m[0].length;
    const v = valueAt(s, at);
    const vAt = s.length - v.length;
    let shape = "variable";
    let filtered = false;
    if (/^true\b/.test(v)) shape = "true";
    else if (v.startsWith("{")) {
      const end = blockEnd(s, vAt);
      shape = "object";
      filtered = end !== -1 && filtersRemoved(s.slice(vAt, end));
    }
    out.push({ line: line(m.index ?? 0), filtered, shape });
  }
  return out.sort((a, b) => a.line - b.line);
}

const one = (src: string) => {
  const sites = judge(src);
  expect(sites, src).toHaveLength(1);
  return sites[0];
};

describe("the judge", () => {
  it("accepts a read that filters removedAt in its own where (control)", () => {
    expect(one(`x.findUnique({ include: { memberships: { where: { removedAt: null }, include: { org: true } } } })`).filtered).toBe(true);
    expect(one(`select: { memberships: { where: { orgId, removedAt: null }, select: { orgId: true } } }`).filtered).toBe(true);
    expect(one(`where: { memberships: { some: { orgId: id, removedAt: null } } }`).filtered).toBe(true);
    expect(one(`memberships: { where: { removedAt: { not: null } } }`).filtered).toBe(true);
  });

  it.each([
    ["no where", `include: { memberships: { include: { org: true } } }`],
    ["true", `include: { memberships: true }`],
    ["a variable", `include: { memberships: membershipArgs }`],
    ["a shorthand", `include: { memberships }`],
    ["a shorthand among others", `include: { org, memberships, sessions: true }`],
    ["a quoted key", `include: { "memberships": { where: { removedAt: null } } }`],
    ["removedAt: undefined", `include: { memberships: { where: { removedAt: undefined } } }`],
    ["removedAt from a variable", `include: { memberships: { where: { removedAt: maybe } } }`],
    ["removedAt nested deeper", `include: { memberships: { where: { AND: [{ removedAt: null }] } } }`],
    ["removedAt in another key's block", `include: { memberships: { include: { org: { where: { removedAt: null } } } } }`],
    // Each of these reads as filtered unless its comment or string is blanked.
    ["a where only in a line comment", `include: { memberships: { include: { org: true }, // , where: { removedAt: null }\n } }`],
    ["a where only in a block comment", `include: { memberships: { take: 5 /*, where: { removedAt: null } */\n } }`],
    ["a where only in a string", `include: { memberships: { include: { org: true }, note: ", where: { removedAt: null }" } }`],
  ])("counts %s as unfiltered", (_name, src) => {
    expect(one(src).filtered).toBe(false);
  });

  it("is not thrown by a regex or a string holding a quote or brace", () => {
    const src = `const re = /["'{]/g; const s = "}{'";\ninclude: { memberships: { where: { removedAt: null } } }`;
    expect(one(src)).toEqual({ line: 2, filtered: true, shape: "object" });
  });

  it("ignores property reads", () => {
    expect(judge(`const n = user.memberships.length; for (const m of user.memberships) use(m);`)).toEqual([]);
  });
});

describe("nested user.memberships reads filter removed members", () => {
  const all = walk(ROOT)
    .filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes("__tests__"))
    .flatMap((f) => judge(readFileSync(f, "utf8")).map((s) => ({ ...s, file: f.split("\\").join("/") })));
  const unfiltered = all.filter((s) => !s.filtered);

  it("finds the reads it is meant to police", () => {
    // Positive control: the org list, the dashboard shell and home page, both
    // reset request reads, the reset confirm read and the calendar invitees
    // filter. A scan that finds fewer is looking at the wrong text.
    expect(all.filter((s) => s.filtered).length).toBeGreaterThanOrEqual(7);
  });

  it("has no unfiltered read outside the allowlist", () => {
    const byFile = new Map<string, typeof unfiltered>();
    for (const s of unfiltered) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
    const unexpected = [...byFile].flatMap(([file, list]) =>
      list.length === (ALLOWED[file]?.sites ?? 0) ? [] : list.map((s) => `${s.file}:${s.line} (${s.shape})`),
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

  it("gives every exception a substantive reason", () => {
    for (const [f, a] of Object.entries(ALLOWED)) expect(a.reason.length, f).toBeGreaterThan(40);
  });
});
