// @vitest-environment node
//
// A plugin's AI tools are on the SAME agent surface as the core ones.
//
// `PluginServerHooks.executeTool` is a second dispatch path: it reaches the same
// database with the same user's identity, but it does not pass through
// `lib/ai/executors/_ctx.ts`, so none of the core gates apply to it. Whatever a
// plugin tool does not check for itself is not checked at all.
//
// WHERE THIS FIRES MATTERS. The public core ships no plugins — `src/plugins/` is
// absent here and populated only in the composed tree (see AGENTS.md on the
// plugin split). So in this repo the sweep finds nothing, and a rule that
// silently passes on an empty set is the vacuity this codebase keeps getting
// bitten by. It is written to say so out loud instead: the count is asserted and
// reported, so "0 plugins scanned" reads as a fact about the checkout rather
// than as a clean bill of health.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_DIR = join(process.cwd(), "src/plugins");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const pluginFiles = existsSync(PLUGIN_DIR) ? walk(PLUGIN_DIR) : [];

/** Files that actually contribute agent tools — the only ones this rule governs. */
const toolContributors = pluginFiles.filter((f) => {
  const src = code(f);
  return /aiTools\s*:/.test(src) || /executeTool\s*[:(]/.test(src);
});

/**
 * The module that actually IMPLEMENTS a plugin's executeTool.
 *
 * The hook is declared in a plugin's `server.ts`, but by convention that file is a
 * manifest — `executeTool: <someExecutor>` and nothing else. Reading the gates off
 * the declaring file therefore asks the wrong file entirely, and it fails in both
 * directions: a plugin whose executor is wide open is reported against a
 * `server.ts` that has nothing wrong in it, and a plugin whose `server.ts` merely
 * happens to mention `assertPermission` passes no matter what its executor does.
 * Either way the rule measures something unrelated to what the tool can reach.
 *
 * So follow the delegation: take the identifier bound to `executeTool:` and find
 * the file that exports it. A hook defined inline resolves to itself, and an
 * identifier that cannot be resolved falls back to the declaring file rather than
 * silently dropping the plugin from the sweep — an unresolvable delegation must
 * still be somebody's problem.
 */
function implementationOf(declaringFile: string): string {
  const delegated = code(declaringFile).match(/executeTool\s*:\s*([A-Za-z_$][\w$]*)/);
  if (!delegated) return declaringFile; // defined inline
  const ident = delegated[1];
  const defines = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${ident}\\b`);
  return pluginFiles.find((f) => defines.test(code(f))) ?? declaringFile;
}

describe("plugin-contributed agent tools enforce access themselves", () => {
  it("reports how much it actually scanned", () => {
    // Not an assertion about correctness — a statement of coverage, so a pass
    // in the public core cannot be mistaken for the composed tree being clean.
     
    console.log(
      `[plugin-tool-scope] plugin dir ${existsSync(PLUGIN_DIR) ? "present" : "ABSENT (public core)"}; ` +
        `${pluginFiles.length} file(s), ${toolContributors.length} contributing agent tools`,
    );
    expect(pluginFiles.length).toBeGreaterThanOrEqual(0);
  });

  it("every plugin tool executor gates on permission AND project", () => {
    // The two questions the core tools ask. A permission MEMBER and VIEWER both
    // hold authorises reading SOME of a thing and says nothing about WHICH — a
    // team-scoped project is closed to non-members, and "exists in the org" is
    // not the same question.
    const offenders = toolContributors
      .filter((f) => /executeTool/.test(code(f)))
      // Judge the implementation, not the one-line hook declaration.
      .map(implementationOf)
      .filter((impl) => {
        const src = code(impl);
        const hasPermission = /assertPermission|assertAllPermissions/.test(src);
        const hasProjectScope =
          /assertProjectRead|getReadableProjectIds|visibleProjectIdsForActor/.test(src);
        // A tool that never touches a project needs only the permission gate.
        const touchesProject = /projectId/.test(src);
        return !hasPermission || (touchesProject && !hasProjectScope);
      });

    expect(
      [...new Set(offenders)].map((f) => f.replace(process.cwd(), ".")),
      "a plugin tool bypasses _ctx.ts — it must call assertPermission, and assertProjectRead when it touches a project. Paths below are the files that IMPLEMENT executeTool, not where the hook is declared",
    ).toEqual([]);
  });
});
