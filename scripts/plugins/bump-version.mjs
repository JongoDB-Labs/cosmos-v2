/**
 * Bump the app version in a composed working tree.
 *
 * `npm version` alone does NOT work here, and fails silently.
 *
 * `sync.mjs` marks every tracked file it writes as `skip-worktree` so composed
 * content can never be committed by accident. Once any plugin declares npm
 * dependencies, package.json and package-lock.json join that set — so
 * `npm version` edits them, `git add -A` ignores them, and the release commits
 * with the OLD version. Nothing errors. The only thing standing between that and
 * a release that ships under the wrong number is the config-assertions gate
 * comparing package.json to the changelog, and that fires late, in CI.
 *
 * This does the bump correctly:
 *  - writes the version field only, reconstructed from what git HEAD has, so the
 *    composed plugin dependencies are never staged into the neutral public core;
 *  - restores the composed working tree afterwards, so a `next build` in the
 *    same session still resolves the plugin's packages;
 *  - leaves skip-worktree exactly as it found it.
 *
 * Usage:
 *   node scripts/plugins/bump-version.mjs 2.241.0
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("[bump-version] usage: node scripts/plugins/bump-version.mjs <x.y.z>");
  process.exit(1);
}

const FILES = ["package.json", "package-lock.json"];
const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** Which of FILES git is currently ignoring changes to. */
function hidden() {
  return git(["ls-files", "-v", ...FILES])
    .split("\n")
    .filter((l) => l.startsWith("S "))
    .map((l) => l.slice(2).trim());
}

const wasHidden = hidden();

// Keep the composed content to put back — it is what makes the local tree
// buildable, and it must not be what gets committed.
const composed = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, "utf8")]));

if (wasHidden.length) git(["update-index", "--no-skip-worktree", ...wasHidden]);

try {
  for (const f of FILES) {
    // Reconstructed from HEAD, not from the working copy: the working copy
    // carries composed plugin dependencies that do not belong in this repo.
    const d = JSON.parse(git(["show", `HEAD:${f}`]));
    d.version = version;
    // The lock repeats the version in its root package entry; leaving that
    // behind makes `npm ci` complain the two disagree.
    if (f === "package-lock.json" && d.packages?.[""]) d.packages[""].version = version;
    writeFileSync(f, `${JSON.stringify(d, null, 2)}\n`);
  }

  git(["add", ...FILES]);

  const staged = git(["diff", "--cached", "--", "package.json"]);
  const leaked = staged
    .split("\n")
    .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"))
    .filter((l) => !l.includes('"version"'));
  if (leaked.length) {
    // Refuse rather than quietly publish a plugin's dependencies from the
    // neutral core.
    console.error("[bump-version] REFUSING: staged package.json changes more than the version:");
    for (const l of leaked) console.error(`    ${l}`);
    process.exit(1);
  }

  console.log(`[bump-version] staged version ${version} (version field only)`);
  console.log("[bump-version] commit it, then the composed tree is restored below.");
} finally {
  // Always put the composed content back, even if the guard above bailed —
  // otherwise the tree is left un-buildable.
  for (const f of FILES) writeFileSync(f, composed[f]);
  if (wasHidden.length) git(["update-index", "--skip-worktree", ...wasHidden]);
}
