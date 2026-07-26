import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Public-repo client-identity gate.
 *
 * cosmos-v2 is a PUBLIC repository; the neutral core must never name a client or
 * private vertical. Client/vertical specifics live only in the separate PRIVATE
 * plugin repos, composed in at build time — never committed here. This test
 * scans every git-tracked file for the forbidden identity tokens and fails
 * loudly on any regression, so a stray literal can't slip back into the public
 * core.
 *
 * If this test flags a legitimate use, neutralize the literal — do not add an
 * allowlist. (This file itself is excluded: it necessarily spells the tokens out
 * in order to search for them.)
 */
const FORBIDDEN =
  /acme|acme|acme|\bAcme\b|acme|\bACME\b|private-assembly|example|example/i;

const SELF = "src/lib/product/__tests__/no-client-identity.arch.test.ts";

// Binary / non-text tracked files can't meaningfully be scanned as utf8.
const BINARY = /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|eot|pdf|mp4|webm|zip|gz)$/i;

describe("public-repo client-identity gate", () => {
  it("no tracked file names a client or private vertical", () => {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean)
      .filter((f) => f !== SELF && !BINARY.test(f));

    const offenders: string[] = [];
    for (const rel of tracked) {
      let text: string;
      try {
        text = readFileSync(join(process.cwd(), rel), "utf8");
      } catch {
        continue; // unreadable (e.g. removed in-tree) — nothing to scan
      }
      if (FORBIDDEN.test(text)) offenders.push(rel);
    }

    expect(
      offenders,
      `Client/vertical identity leaked into public tracked files — neutralize these:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
