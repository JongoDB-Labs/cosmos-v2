import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Mention tokens must be rendered through `mentionsToPlainText`, never stripped
 * with an inline regex.
 *
 * The pattern this bans shipped in SIX places, all identical:
 *
 *     content.replace(/<@[0-9a-f-]{36}>/gi, "@user")
 *
 * and carried two defects everywhere it appeared. It rendered a hardcoded
 * `"@user"`, so a notification told the recipient someone was mentioned but
 * never who — including when it was them. And it matched only the legacy
 * 36-character people form, so a typed token (`<@workItem:…>`, `<@project:…>`)
 * survived into the reader's inbox as a raw uuid.
 *
 * Six copies is what made it worth a test rather than a fix: the rule is only
 * as good as the number of call sites that use it, and the next notification
 * producer will copy whichever neighbour it finds. A unit test on the resolver
 * cannot see a caller that does not call it — a source-level check can.
 *
 * This asserts the PROPERTY (no hand-rolled token stripping in app source), not
 * that today's six call sites were edited, so it fails on a seventh.
 */

/** Any inline attempt to strip or rewrite a `<@…>` token. */
const HAND_ROLLED_TOKEN_REGEX = /replace\(\s*\/<@/;

/**
 * Comments are stripped before scanning.
 *
 * Without this, the doc comment on `plain-text.ts` — which quotes the very
 * pattern being banned, so a reader knows what was replaced — would trip the
 * ban, and the file would need an allowlist entry that exempted a COMMENT
 * rather than any real code. An exemption that is not load-bearing is worse
 * than none: it reads as "this file is allowed to do the bad thing", and the
 * day it genuinely does, nothing complains.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("mention tokens are resolved in one place", () => {
  it("no file hand-rolls a <@…> strip outside the owning module", () => {
    const offenders = walk("src").filter((f) =>
      HAND_ROLLED_TOKEN_REGEX.test(stripComments(readFileSync(f, "utf8"))),
    );

    expect(
      offenders,
      `These files strip mention tokens by hand instead of calling ` +
        `mentionsToPlainText() from @/lib/mentions/plain-text:\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the regex this bans would actually have caught the shipped code", () => {
    // The positive control. Without this, a typo in HAND_ROLLED_TOKEN_REGEX
    // would make the test above pass over every offender in the tree — the
    // "green over an empty set" failure mode.
    const shipped = `.replace(/<@[0-9a-f-]{36}>/gi, "@user")`;
    expect(HAND_ROLLED_TOKEN_REGEX.test(shipped)).toBe(true);
  });

  it("scans a non-trivial number of files", () => {
    // Second positive control: if `walk` silently returned [] (a bad path, a
    // changed layout), the ban above would be vacuous and still green.
    expect(walk("src").length).toBeGreaterThan(500);
  });

  it("strips comments, but not code, before scanning", () => {
    // Third control: if stripComments were too greedy it would erase the code
    // it is meant to police and the ban would go quiet.
    expect(stripComments('/* .replace(/<@x>/, "y") */')).not.toMatch(HAND_ROLLED_TOKEN_REGEX);
    expect(stripComments('// .replace(/<@x>/, "y")')).not.toMatch(HAND_ROLLED_TOKEN_REGEX);
    expect(stripComments('const a = 1;\nx.replace(/<@y>/g, "z");')).toMatch(
      HAND_ROLLED_TOKEN_REGEX,
    );
  });
});
