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
 * It covers file content AND path. Commit messages are guarded separately, at commit
 * time, by scripts/check-commit-msg-identity.mjs via the commit-msg hook — both
 * import the pattern below from scripts/client-identity.mjs so the two can never
 * disagree.
 *
 * If this test flags a legitimate use, neutralize the literal — do not add an
 * allowlist. (The pattern files are excluded: they carry the search machinery.)
 */
import { FORBIDDEN, PATTERN_FILES } from "../../../../scripts/client-identity.mjs";

// Binary / non-text tracked files can't meaningfully be scanned as utf8.
const BINARY = /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|eot|pdf|mp4|webm|zip|gz)$/i;

const git = (args: string[]) =>
  execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Tracked files whose WORKTREE copy is composed output rather than the committed
 * source: `prisma/schema.prisma` and the two plugin registries, which
 * `scripts/plugins/sync.mjs` overwrites in place on any tree that has been built.
 *
 * Reading those from disk made this gate fail on every composed checkout, naming
 * three files whose COMMITTED content is clean — and the fix it demanded (take the
 * client names out of core) is unsatisfiable, because they are a private plugin's
 * models injected at build time and they do not belong to this repo at all. The
 * gate was therefore only honest in CI, where nothing is composed.
 *
 * The list is not hardcoded here. sync.mjs marks exactly these skip-worktree, so
 * git holds the answer and this cannot drift when sync starts managing another
 * file. It also means the gate keeps its teeth for the case that matters: a
 * developer editing one of them follows the ritual and CLEARS the flag first, so
 * the file reads from the worktree again and a freshly typed literal is caught.
 */
function composedPaths(): Set<string> {
  return new Set(
    git(["ls-files", "-v"])
      .split("\n")
      .filter((l) => l.startsWith("S "))
      .map((l) => l.slice(2)),
  );
}

describe("public-repo client-identity gate", () => {
  it("no tracked file names a client or private vertical", () => {
    const composed = composedPaths();
    const tracked = git(["ls-files"])
      .split("\n")
      .filter(Boolean)
      .filter((f) => !PATTERN_FILES.includes(f) && !BINARY.test(f));

    const offenders: string[] = [];
    for (const rel of tracked) {
      let text: string;
      try {
        // A composed file is read from the INDEX, which is what a commit would
        // carry; everything else from disk, so an uncommitted literal still fails.
        text = composed.has(rel)
          ? git(["show", `:${rel}`])
          : readFileSync(join(process.cwd(), rel), "utf8");
      } catch {
        continue; // unreadable (e.g. removed in-tree) — nothing to scan
      }
      if (FORBIDDEN.test(text)) offenders.push(rel);
    }

    // PATHS too, not just contents. A file can name a client without saying so
    // inside it — a migration folder is the obvious way, since its name is
    // chosen by whoever generated it and its SQL may be perfectly neutral.
    // Promoting a vertical's tables into this repo creates exactly those
    // folders, so the hole was about to be walked through.
    for (const rel of tracked) {
      if (FORBIDDEN.test(rel) && !offenders.includes(rel)) offenders.push(rel);
    }

    // A floor. Every assertion here is "found nothing", which is also what a
    // broken file list produces, so the count is asserted rather than assumed.
    expect(tracked.length).toBeGreaterThan(500);

    expect(
      offenders,
      `Client/vertical identity leaked into public tracked files — neutralize these:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
