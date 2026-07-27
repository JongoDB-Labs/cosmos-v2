import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * End-to-end exercise of the plugin composition, against a synthetic plugin.
 *
 * Nothing tested `sync.mjs` itself. Its unit-testable helpers (merge-deps,
 * render-registry, slug) have specs, but the script that ORCHESTRATES them ran
 * only in a developer's terminal and in the release build — where a failure
 * means a broken release rather than a red PR.
 *
 * That gap shipped a real outage: the dependency-merging branch exited 127 on a
 * GitHub runner and the v2.240.0 image never built. It had never run in CI,
 * because it only executes when a plugin ACTUALLY declares npm dependencies and
 * none did until then. The very first release to exercise it was the one it
 * broke.
 *
 * Runs in a throwaway copy of the repo: `sync.mjs` writes into src/, edits
 * package.json and sets skip-worktree, so pointing it at the real working tree
 * from a test would be destructive.
 */

let sandbox: string;
const SLUG = "synthetic-test-plugin";

/** Everything sync.mjs reads, and nothing else. */
function buildSandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-sync-"));

  // A git repo: sync.mjs uses .git/info/exclude and `git update-index`.
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });

  mkdirSync(join(root, "scripts", "plugins"), { recursive: true });
  for (const f of ["sync.mjs", "merge-deps.mjs", "render-registry.mjs", "slug.mjs"]) {
    const src = join(process.cwd(), "scripts", "plugins", f);
    if (existsSync(src)) cpSync(src, join(root, "scripts", "plugins", f));
  }

  mkdirSync(join(root, "prisma"), { recursive: true });
  writeFileSync(
    join(root, "prisma", "schema.prisma"),
    [
      "model Organization {",
      "  id String @id",
      "  // @plugin-backrel:Organization",
      "}",
      "",
      "// @plugin-schema-fragments",
      "",
    ].join("\n"),
  );

  mkdirSync(join(root, "src", "lib", "plugins", "registry"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "sandbox", version: "0.0.0", dependencies: { zod: "^3.0.0" } }, null, 2) + "\n",
  );
  // A lockfile npm can refresh. Minimal but valid.
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify(
      { name: "sandbox", version: "0.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "sandbox", version: "0.0.0" } } },
      null,
      2,
    ) + "\n",
  );

  // The synthetic plugin: an overlay file, a schema fragment, a back-relation,
  // and — the part that broke production — a declared npm dependency.
  const p = join(root, "plugins", SLUG);
  mkdirSync(join(p, "overlay", "src", "plugins", SLUG), { recursive: true });
  mkdirSync(join(p, "prisma"), { recursive: true });
  writeFileSync(
    join(p, "plugin.json"),
    JSON.stringify(
      {
        slug: SLUG,
        version: "1.0.0",
        dependencies: { "left-pad": "^1.3.0" },
        schemaBackRelations: { Organization: ["syntheticThings SyntheticThing[]"] },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(p, "overlay", "src", "plugins", SLUG, "marker.ts"), "export const MARKER = 1;\n");
  writeFileSync(
    join(p, "prisma", `${SLUG}.prisma`),
    "model SyntheticThing {\n  id String @id\n}\n",
  );

  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "sandbox"], { cwd: root });
  return root;
}

describe("sync.mjs composition (end to end)", () => {
  let output = "";
  let failure: Error | null = null;

  beforeAll(() => {
    sandbox = buildSandbox();
    try {
      output = execFileSync("node", ["scripts/plugins/sync.mjs"], {
        cwd: sandbox,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      failure = e as Error;
      output = String((e as { stdout?: string }).stdout ?? "") + String((e as { stderr?: string }).stderr ?? "");
    }
  }, 180_000);

  afterAll(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  it("completes without error", () => {
    expect(failure, `sync.mjs failed:\n${output}`).toBeNull();
  });

  it("copies the overlay into the app tree", () => {
    expect(existsSync(join(sandbox, "src", "plugins", SLUG, "marker.ts"))).toBe(true);
  });

  it("appends the schema fragment at the marker", () => {
    const schema = readFileSync(join(sandbox, "prisma", "schema.prisma"), "utf8");
    expect(schema).toContain("model SyntheticThing");
  });

  it("injects the declared back-relation", () => {
    const schema = readFileSync(join(sandbox, "prisma", "schema.prisma"), "utf8");
    expect(schema).toContain("syntheticThings SyntheticThing[]");
  });

  /**
   * The regression this file exists for. A plugin declaring npm dependencies
   * takes a branch that shells out to npm to refresh the lockfile, and that
   * branch exited 127 on a GitHub runner while working fine locally.
   */
  it("merges a plugin's npm dependency into package.json", () => {
    const pkg = JSON.parse(readFileSync(join(sandbox, "package.json"), "utf8"));
    expect(pkg.dependencies["left-pad"]).toBe("^1.3.0");
    // The core's own dependency must survive the merge.
    expect(pkg.dependencies.zod).toBe("^3.0.0");
  });

  it("refreshes the lockfile, so `npm ci` cannot fail on a disagreement", () => {
    expect(output, `expected the lock-refresh branch to run:\n${output}`).toContain(
      "refreshing package-lock.json",
    );
    const lock = JSON.parse(readFileSync(join(sandbox, "package-lock.json"), "utf8"));
    expect(JSON.stringify(lock)).toContain("left-pad");
  });

  it("keeps composed output out of a commit", () => {
    // Untracked overlay files are excluded; tracked files it edited are hidden.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: sandbox, encoding: "utf8" });
    expect(status).not.toContain(`src/plugins/${SLUG}`);
    expect(status).not.toContain("package.json");
  });
});
