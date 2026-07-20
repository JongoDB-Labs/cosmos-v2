// Per-build project safety hooks for Foreman build agents. Code-defined only (never
// user-supplied). PreToolUse on Bash denies a `git commit` that would ship a release-
// invariant violation (package.json version != CHANGELOG top). Reads the worktree at
// hook time; best-effort — a read error never blocks the agent.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { shouldDenyCommit } from "@/lib/foreman/harness";

export function buildProjectHooks(worktreeDir: string) {
  return {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          async (input: unknown) => {
            const cmd = (input as { tool_input?: { command?: string } }).tool_input?.command ?? "";
            if (!/git\s+commit/i.test(cmd)) return {};
            try {
              const pkg =
                (JSON.parse(await readFile(join(worktreeDir, "package.json"), "utf8")) as { version?: string }).version ?? "";
              const cl = await readFile(join(worktreeDir, "src/lib/changelog.ts"), "utf8");
              const top = cl.slice(cl.indexOf("CHANGELOG: Release[] = [")).match(/version:\s*"([^"]+)"/)?.[1] ?? "";
              if (pkg && top && shouldDenyCommit(cmd, pkg, top)) {
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: `Release invariant: package.json=${pkg} but CHANGELOG[0]=${top}. Prepend a matching CHANGELOG entry (newest first) before committing.`,
                  },
                };
              }
            } catch {
              // best-effort — never block the agent on a hook read error
            }
            return {};
          },
        ],
      },
    ],
  };
}
