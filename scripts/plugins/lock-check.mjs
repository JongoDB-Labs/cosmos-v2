/**
 * Check a plugins.lock.json CHANGE: the file on the base branch against the
 * file in this working tree.
 *
 * The rule lives in lock-diff.mjs and is unit-tested there. This file is only
 * the I/O around it, so there is ONE definition of the rule with two callers —
 * CI and a developer before pushing — rather than a copy in a workflow's shell
 * that drifts, and whose drifted copy is the one that passes.
 *
 * Usage:
 *   node scripts/plugins/lock-check.mjs --base <file> [--head <file>]
 *
 *   # in CI, or locally before pushing:
 *   git fetch --quiet --depth=1 origin main
 *   git show FETCH_HEAD:plugins.lock.json > /tmp/base-lock.json
 *   node scripts/plugins/lock-check.mjs --base /tmp/base-lock.json
 *
 * `--head` defaults to ./plugins.lock.json.
 *
 * FAILS CLOSED. An unreadable or unparsable file on either side exits non-zero:
 * this check exists because a lock change can be a silent revert, and "I could
 * not tell" must never present as "nothing to see". The same reason the sweep
 * it guards treats a partial read as an error rather than as no drift.
 */
import { readFileSync } from "node:fs";
import { judgeLockDiff } from "./lock-diff.mjs";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const basePath = arg("--base");
const headPath = arg("--head") ?? "plugins.lock.json";

if (!basePath) {
  console.error("[lock-check] --base <file> is required (the lockfile as it is on the base branch)");
  process.exit(2);
}

/** Parse a lockfile, or exit non-zero saying which side could not be read. */
function load(path, side) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`[lock-check] cannot read the ${side} lockfile at ${path}: ${e.code ?? e.message}`);
    console.error(`[lock-check] the direction of this change is therefore UNKNOWN, which is not a pass.`);
    process.exit(1);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.error(`[lock-check] the ${side} lockfile at ${path} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const plugins = json?.plugins;
  if (plugins === null || typeof plugins !== "object" || Array.isArray(plugins)) {
    console.error(`[lock-check] the ${side} lockfile at ${path} has no "plugins" object`);
    process.exit(1);
  }
  return { plugins, text };
}

const base = load(basePath, "base");
const head = load(headPath, "head");

const baseCount = Object.keys(base.plugins).length;
const headCount = Object.keys(head.plugins).length;

// Nothing to judge is a legitimate outcome — most PRs do not touch the lock —
// but it has to say so, naming what it compared. A for-each check over an empty
// set passes while reading nothing, and that silence is indistinguishable from
// a clean bill of health.
if (base.text === head.text) {
  console.log(`[lock-check] plugins.lock.json is unchanged from the base branch (${headCount} pin(s)) — nothing to judge`);
  process.exit(0);
}

if (headCount === 0) {
  console.error(`[lock-check] the proposed lockfile pins NO plugins — every build would fall back to plugin main`);
  process.exit(1);
}

const { problems, notices } = judgeLockDiff(base.plugins, head.plugins);

for (const n of notices) console.log(`[lock-check] ${n.message}`);
for (const p of problems) console.error(`[lock-check] ${p.kind}: ${p.message}`);

if (problems.length > 0) {
  console.error(
    `[lock-check] ${problems.length} problem(s) in a lock change over ${headCount} pin(s) — ` +
      `compared against ${baseCount} pin(s) on the base branch.`,
  );
  process.exit(1);
}

console.log(
  `[lock-check] ok — ${headCount} pin(s) judged against ${baseCount} on the base branch, ` +
    `${notices.length} of them reported above.`,
);
