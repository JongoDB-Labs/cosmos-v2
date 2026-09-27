// @vitest-environment node
//
// Doc- and dead-code drift in `src/lib/ai`, locked out statically.
//
// Every item below is a REGRESSION this file exists to catch, not a style
// preference. They share one failure mode: the code moved and the prose, the
// wrapper or the unreachable arm did not — and each survivor then reads as a
// reason to undo the move. The stale comments in particular are the dangerous
// kind, because they justify the OPPOSITE of what the code now does:
//
//   - `_ctx.ts` justified not selecting `permissions` with "BigInt isn't
//     serializable". The mask is a decimal-string TEXT column (see
//     `maskFromDb` in rbac/effective-permissions.ts), so that reason is false —
//     and a false reason invites someone to select the column once they notice.
//     The real rule (never ship a raw mask) lives in AGENTS.md.
//   - `goals-kpis.ts` claimed the KPI surface was "intentionally OKR-uniform"
//     while `createKpi`/`updateKpi` gate on PROJECT_UPDATE to MATCH the HTTP
//     routes. That is the drift `_ctx.ts` records fixing; the comment read as a
//     licence to restore the weaker bit.
//   - `okrs.ts` justified the unnarrowed org-wide objective query with
//     "objectives with no project are not project-scoped data" — but
//     `Objective.projectId` is NON-NULL, so that case does not exist.
//   - `slack.ts` credited a "central dispatcher" that reads
//     `connectorToolNames()` from the connector registry and has never read
//     `SLACK_TOOL_NAMES`.
//
// A grep over source text is crude and it only proves the prose is ABSENT, not
// that what replaced it is true. It earns its place by failing the moment any
// of these is reinstated — which is precisely how they accumulated.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const AI = join(SRC, "lib", "ai");

function read(...parts: string[]): string {
  return readFileSync(join(AI, ...parts), "utf8");
}

/**
 * Source with comment line-breaks flattened, so a phrase is found wherever the
 * wrapping happens to fall.
 *
 * Not cosmetic: the first version of this file matched the raw text and MISSED
 * the okrs.ts sentence entirely, because it wrapped across two `//` lines.
 * Mutation testing caught it — the rule passed against the very comment it was
 * written to forbid, which is the failure mode an arch test is supposed to not
 * have.
 */
function prose(...parts: string[]): string {
  return read(...parts).replace(/\n\s*(?:\/\/|\*)?[ \t]*/g, " ");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

/** The body of a named top-level function, so a rule binds per function. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} should exist`).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n(?:export )?(?:async )?function /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("src/lib/ai carries no stale rationale", () => {
  it("_ctx.ts does not justify the permissions rule with BigInt serialisation", () => {
    const src = prose("executors", "_ctx.ts");
    expect(src).not.toMatch(/BigInt isn't serializable/);
    // The rule itself must survive the deletion of its wrong reason.
    expect(src).toMatch(/do not `include`\/`select` raw `permissions: true`/);
  });

  it("goals-kpis.ts does not claim the KPI surface is OKR-uniform", () => {
    const src = read("executors", "goals-kpis.ts");
    expect(prose("executors", "goals-kpis.ts")).not.toMatch(/intentionally OKR-uniform/);
    // …because both KPI writes pass the routes' PROJECT_UPDATE bit. If that
    // ever stops being true, this assertion is the thing that says so.
    for (const fn of ["createKpi", "updateKpi"]) {
      expect(
        functionBody(src, fn),
        `${fn} must pass PROJECT_UPDATE to assertProjectManage, as the KPI routes do`,
      ).toMatch(/assertProjectManage\([^)]*Permission\.PROJECT_UPDATE/);
    }
  });

  it("okrs.ts does not invent a project-less objective", () => {
    // `Objective.projectId` is NON-NULL (prisma/schema.prisma), so the case the
    // deleted sentence described — and used to excuse the unnarrowed org-wide
    // query below it — cannot occur.
    expect(prose("executors", "okrs.ts")).not.toMatch(
      /[Oo]bjectives with no project are not project-scoped data/,
    );
  });

  it("slack.ts credits no dispatcher that does not read it", () => {
    const src = read("executors", "slack.ts");
    const text = prose("executors", "slack.ts");
    expect(text).not.toMatch(/O\(1\) membership in the central dispatcher/);
    expect(text).not.toMatch(/parent dispatcher falls through to other tool families/);
    // The set stays exported — its real consumers are the invariant tests.
    expect(src).toMatch(/export const SLACK_TOOL_NAMES/);
  });
});

describe("src/lib/ai carries no dead code", () => {
  it("nango.ts has no unreachable default arm", () => {
    const src = read("executors", "nango.ts");
    // `executeNangoTool` returns early for any name outside NANGO_TOOL_NAMES,
    // and that set is exactly the switch's three cases — so a `default` arm
    // cannot run.
    expect(functionBody(src, "executeNangoTool")).not.toMatch(/^\s*default:/m);
    expect(src).toMatch(/if \(!NANGO_TOOL_NAMES\.has\(name\)\) return null;/);
  });

  it("claude-oauth-core.ts seals directly instead of wrapping and unwrapping", () => {
    const src = read("claude-oauth-core.ts");
    // `toSealedJson` built a `{ sealed }` object that all four call sites
    // immediately re-opened with `.sealed`, because TokenStore.write takes bare
    // ciphertext. Constructed and discarded on every path.
    expect(src).not.toMatch(/toSealedJson/);
    expect(src).toMatch(/access: sealSecret\(accessToken\)/);
    // The read side and the persisted-shape type still describe the column.
    expect(src).toMatch(/function fromSealedJson/);
    expect(src).toMatch(/type SealedJson = \{ sealed: string \}/);
  });

  it("createWorkItem does not re-ask whether the project exists", () => {
    // `assertProjectRead` → `isProjectVisible` already scopes its lookup by
    // orgId, so a missing or cross-tenant project yields the same
    // "Project not found". The preceding findFirst was a second round-trip for
    // an answer the gate below already gives.
    const body = functionBody(read("executors", "work-items.ts"), "createWorkItem");
    expect(body).not.toMatch(/prisma\.project\.findFirst/);
    expect(body).toMatch(/assertProjectRead\(ctx, data\.projectId, "ITEM_CREATE"\)/);
  });

  it("the dormant MCP config builder is gone and unreferenced", () => {
    expect(existsSync(join(AI, "mcp-config.ts"))).toBe(false);
    // Exclude THIS file from the scan: it necessarily names the symbols it
    // forbids, so scanning itself would self-flag. Same reason
    // single-path.arch.test.ts excludes itself from its own grep.
    const self = join("lib", "ai", "__tests__", "ai-lib-hygiene.arch.test.ts");
    const offenders = walk(SRC).filter((f) => {
      if (f.endsWith(self)) return false;
      const src = readFileSync(f, "utf8");
      return (
        /["'][^"']*ai\/mcp-config["']/.test(src) ||
        /\b(?:buildMcpConfigForOrg|cleanupMcpConfig)\b/.test(src)
      );
    });
    expect(
      offenders,
      `mcp-config was deleted with the host-CLI flag it served:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
