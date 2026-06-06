// src/lib/ai/egress/__tests__/single-path.arch.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next" || name === ".git") continue;
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(p)) acc.push(p);
  }
  return acc;
}

describe("single egress path", () => {
  const root = join(process.cwd(), "src");
  // Exclude THIS arch test from the scan: it necessarily contains the very
  // string literals it forbids (`spawn("claude"`, `--mcp-config`) as the
  // patterns it greps for. Scanning itself would self-flag — the guard is for
  // real wiring, not the guard's own definition.
  const self = join("ai", "egress", "__tests__", "single-path.arch.test.ts");
  const files = walk(root).filter((f) => !f.endsWith(self));

  it("nothing outside egress/ imports the provider", () => {
    const offenders = files.filter((f) => {
      if (f.includes(join("ai", "egress"))) return false; // egress/ owns the provider
      return /["'][^"']*ai\/egress\/provider["']/.test(readFileSync(f, "utf8"));
    });
    expect(offenders, `These import the provider directly:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the host claude CLI and pool are gone", () => {
    const banned = files.filter((f) => /ai\/(claude-cli|cli-pool)\.ts$/.test(f));
    expect(banned, "claude-cli.ts / cli-pool.ts must be deleted in v2").toEqual([]);
  });

  it("no source spawns a `claude` binary and no --mcp-config remains", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /spawn\(\s*["']claude["']/.test(src) || src.includes("--mcp-config");
    });
    expect(offenders, `Forbidden host-CLI/MCP wiring in:\n${offenders.join("\n")}`).toEqual([]);
  });
});
