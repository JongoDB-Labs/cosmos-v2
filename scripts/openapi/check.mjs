// scripts/openapi/check.mjs  (npm run check:openapi)
//
// CI gate for the contract pipeline:
//   1. regenerate contracts.generated.ts + openapi/cosmos-v1.json and fail if
//      either differs from what is committed (a stale spec documents an API
//      that isn't the one running);
//   2. with OPENAPI_BASE set (a git ref: CI passes the PR base), fail if
//      openapi/internal-routes.txt GREW. It is a ratchet; see routes.mjs.
//   3. with OPENAPI_BASE set, fail if the public spec changed and the API
//      changelog didn't.
// The structural rules (every operation covered, contracts pure, spec lint)
// are vitest specs: src/lib/openapi/coverage.arch.test.ts and
// __tests__/spec-lint.test.ts. Breaking changes are oasdiff's job, in CI.
import { execFileSync } from "node:child_process";
import { INTERNAL_ROUTES_FILE, readInternalRoutes } from "./routes.mjs";

const API_CHANGELOG_FILE = "src/lib/api-changelog.ts";
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });

run("node", ["scripts/openapi/collect.mjs"]);
run("npx", ["tsx", "scripts/openapi/build.mts"]);

try {
  run("git", ["diff", "--exit-code", "--stat", "--", "openapi/cosmos-v1.json", "src/lib/openapi/contracts.generated.ts", "src/lib/openapi/schemas/enums.generated.ts"]);
} catch {
  console.error("\ncheck:openapi: the committed spec is stale. Run `npm run openapi` and commit the result.");
  process.exit(1);
}

const base = process.env.OPENAPI_BASE;
if (base) {
  let before = null;
  try {
    const text = execFileSync("git", ["show", `${base}:${INTERNAL_ROUTES_FILE}`], { encoding: "utf8" });
    before = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).length;
  } catch {
    console.log(`check:openapi: no ${INTERNAL_ROUTES_FILE} on ${base} yet; ratchet starts here.`);
  }
  const now = readInternalRoutes().length;
  if (before !== null && now > before) {
    console.error(
      `\ncheck:openapi: ${INTERNAL_ROUTES_FILE} grew from ${before} to ${now} line(s).\n` +
      "A new v1 route needs a route.contract.ts (stability \"internal\" keeps it out of the public spec)\n" +
      "instead of a line on the list. See scripts/openapi/routes.mjs.",
    );
    process.exit(1);
  }
  if (before !== null) console.log(`check:openapi: internal-routes ${before} -> ${now}.`);

  // 3. A change to the published spec is a change API clients can see, so it
  //    needs an API changelog entry (src/lib/api-changelog.ts, which renders at
  //    /developers/changelog). Internal contracts don't touch the public spec.
  const changed = (file) => {
    try {
      execFileSync("git", ["diff", "--quiet", base, "--", file]);
      return false;
    } catch {
      return true;
    }
  };
  if (changed("openapi/cosmos-v1.json") && !changed(API_CHANGELOG_FILE)) {
    console.error(
      `\ncheck:openapi: openapi/cosmos-v1.json changed but ${API_CHANGELOG_FILE} didn't.\n` +
      "Add an entry saying what changed for API clients (newest first). A breaking change also needs\n" +
      "`breaking: true`, a new date version in src/lib/openapi/version.ts and the api-breaking PR label.",
    );
    process.exit(1);
  }
}
console.log("check:openapi: OK");
