// src/lib/db/no-nul-bytes.arch.test.ts
//
// A raw NUL byte in a source file makes git treat the whole file as BINARY.
//
// It is a legitimate separator inside a string — it cannot occur in a name, so
// `${a}\u0000${b}` is a sound composite map key — and typing it as a literal
// rather than an escape costs nothing at runtime and everything at review time:
//
//     $ git diff --stat -- src/components/mentions/hooks.ts
//      src/components/mentions/hooks.ts | Bin 3380 -> 3385 bytes
//      1 file changed, 0 insertions(+), 0 deletions(-)
//
// Every change to such a file lands with no reviewable diff, here and in the
// web UI. `grep -r` skips it too, reporting "binary file matches" instead of the
// matching lines, which silently narrows any search that crosses it.
//
// Two files had drifted into this state and nothing noticed, because nothing
// looked. The fix is a two-character change — `\u0000` instead of the byte —
// and this test is what keeps it fixed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname } from "node:path";

/** Formats that are legitimately binary and are expected to contain NULs. */
const BINARY = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".avif", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".zip", ".gz", ".tar", ".wasm",
  ".docx", ".xlsx", ".pptx", ".odt", ".ods",
  ".mp3", ".mp4", ".webm", ".wav", ".ogg",
]);

function trackedTextFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((f) => f && !BINARY.has(extname(f).toLowerCase()));
}

describe("no NUL bytes in tracked source", () => {
  const files = trackedTextFiles();

  it("scans a plausible number of files", () => {
    // floor: if `git ls-files` or the filter breaks, the rule below passes
    // vacuously and looks permanently green.
    expect(files.length).toBeGreaterThan(500);
  });

  it("no tracked text file contains a raw NUL byte", () => {
    const offenders: string[] = [];
    for (const f of files) {
      let buf: Buffer;
      try {
        buf = readFileSync(f);
      } catch {
        continue; // deleted between listing and reading
      }
      if (buf.includes(0)) offenders.push(`${f} (${buf.filter((b) => b === 0).length})`);
    }
    expect(
      offenders,
      `These files contain a raw NUL byte, so git treats them as binary and every\n` +
        `change to them lands with no reviewable diff. Write the byte as an escape\n` +
        `(\\u0000) instead — the string is identical, the file stays text:\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
