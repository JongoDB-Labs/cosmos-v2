// The hand-validation plans under `docs/` are executable instructions: a tester
// (human or agent) walks them step by step and marks pass/fail. A step that names
// a route, a column or a version the code no longer has does not fail loudly — it
// fails *as the feature*, and the tester records a defect that isn't there. Eleven
// such lines shipped: checklists for RAG/pgvector/`semantic_search` that already
// exist, a Phase 1 entry crediting `callClaudeCliStreaming()` and the `TOOL_CALL:`
// text protocol (both gone), a whole Phase 2 for a `claude` CLI pool that
// single-path.arch.test.ts now *forbids*, chat steps pointing at `/chat` (the team
// channel app) instead of `/assistant`, an integrations "stub" that renders a live
// manager, and two pinned version strings that can never match package.json.
//
// Source-level rather than behavioural because these docs have no runtime: the
// text as written IS the artifact. Follows the existing *.arch.test.ts pattern
// (see carryover-plan-hygiene.arch.test.ts, which guards docs/v1-carryover/ the
// same way).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const PATHS = [
  "docs/AI-CHAT-MIGRATION-PLAN.md",
  "docs/AI-CHAT-TEST-PLAN.md",
  "docs/SETTINGS-VALIDATION-PLAN.md",
  "docs/VALIDATION-GUIDE.md",
] as const;

const docs = PATHS.map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));

// Assembled, never written literally: single-path.arch.test.ts fails the build if
// the flag's exact spelling appears anywhere under src/ — including in a guard
// that only wants to grep docs for it.
const MCP_FLAG = ["--mcp", "config"].join("-");

/** Files whose text matches, as repo-relative paths. */
function offenders(re: RegExp, only?: readonly string[]): string[] {
  return docs
    .filter((d) => (only ? only.includes(d.path) : true))
    .filter((d) => re.test(d.text))
    .map((d) => d.path);
}

function doc(path: (typeof PATHS)[number]): string {
  return docs.find((d) => d.path === path)!.text;
}

describe("validation docs do not plan work the repo already shipped", () => {
  it("finds the validation docs at all", () => {
    // Guards the guard: if a doc is renamed, every assertion below would start
    // passing vacuously. readFileSync already throws, but assert the shape too.
    expect(docs).toHaveLength(4);
    expect(docs.every((d) => d.text.length > 500)).toBe(true);
  });

  it("does not list RAG embeddings / pgvector / semantic_search as unstarted", () => {
    // prisma/schema.prisma carries `embedding Unsupported("vector(384)")`,
    // src/lib/rag/embed.ts runs MiniLM in-process, src/lib/ai/tools/rag.ts
    // defines `semantic_search`. Guard the guard first.
    expect(readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8")).toContain('Unsupported("vector(384)")');
    expect(readFileSync(join(ROOT, "src/lib/rag/embed.ts"), "utf8")).toContain("all-MiniLM-L6-v2");
    expect(readFileSync(join(ROOT, "src/lib/ai/tools/rag.ts"), "utf8")).toContain('name: "semantic_search"');

    // No OPEN work item for any of it in the migration plan. (The test plan may
    // still say `- [ ] curl … semantic_search`: that is a step to run, not work
    // to do.)
    expect(
      offenders(/- \[ \][^\n]*(?:pgvector|`semantic_search|embedding` column)/i, [
        "docs/AI-CHAT-MIGRATION-PLAN.md",
      ]),
    ).toEqual([]);
    // And no claim that embeddings are faked or that pgvector is missing.
    expect(offenders(/pseudo-embeddings|pgvector NOT installed|not real embeddings/i)).toEqual([]);
    expect(offenders(/TODO\(rag\) (?:markers )?in\s+`?src\/lib\/rag\/embed\.ts/i)).toEqual([]);
  });

  it("does not credit the removed host-CLI streaming entry point or TOOL_CALL protocol", () => {
    // Neither symbol exists in src/; agent-loop.ts records that both are gone.
    expect(offenders(/callClaudeCliStreaming/)).toEqual([]);
    expect(offenders(/strips raw `TOOL_CALL/)).toEqual([]);
  });

  it("does not plan the `claude` CLI pool that single-path.arch.test.ts forbids", () => {
    const arch = readFileSync(
      join(ROOT, "src/lib/ai/egress/__tests__/single-path.arch.test.ts"),
      "utf8",
    );
    // Guard the guard: the ban these docs must not contradict.
    expect(arch).toContain("claude-cli.ts / cli-pool.ts must be deleted in v2");
    expect(arch).toContain(MCP_FLAG);

    // No open checklist item or test step for the pool, its session column, or
    // the host-CLI MCP flag. The migration plan may *name* cli-pool.ts once, in
    // the "Out of scope" table, to record why it is not being built.
    expect(offenders(/- \[ \][^\n]*cli-pool\.ts/)).toEqual([]);
    expect(offenders(/--input-format stream-json|pkill -f "claude|SELECT cli_session_id/)).toEqual([]);
    expect(offenders(new RegExp(MCP_FLAG))).toEqual([]);
    expect(offenders(/^#+ Phase 2 — Persistent CLI/m)).toEqual([]);
    // The decision itself is kept, as one line under "Out of scope".
    expect(doc("docs/AI-CHAT-MIGRATION-PLAN.md")).toMatch(
      /Out of scope[\s\S]*single-path\.arch\.test\.ts/,
    );
  });

  it("sends the AI-chat tester to /assistant, not the team-channel /chat app", () => {
    expect(existsSync(join(ROOT, "src/app/(dashboard)/[orgSlug]/assistant"))).toBe(true);
    expect(
      existsSync(
        join(ROOT, "src/app/api/v1/orgs/[orgId]/assistant/conversations/[conversationId]/messages/route.ts"),
      ),
    ).toBe(true);

    const plan = doc("docs/AI-CHAT-TEST-PLAN.md");
    expect(plan).toContain("/[orgSlug]/assistant");
    expect(plan).toMatch(/\/assistant\/conversations\/:id\/messages/);
    expect(plan).not.toMatch(/chat\/conversations\/:id\/messages/);
  });

  it("does not call the integrations settings page a stub", () => {
    // The page renders <IntegrationsManager />, and BUG-26 exists nowhere else.
    expect(
      readFileSync(join(ROOT, "src/app/(dashboard)/[orgSlug]/settings/integrations/page.tsx"), "utf8"),
    ).toContain("<IntegrationsManager");
    expect(offenders(/BUG-26/)).toEqual([]);
  });

  it("does not pin a settings sub-page count that drifts", () => {
    // src/app/(dashboard)/[orgSlug]/settings/ holds roughly two dozen sub-pages.
    expect(offenders(/All 11 sub-pages/)).toEqual([]);
  });

  it("does not assert a hard-coded app version", () => {
    // AGENTS.md: the sidebar version comes from `npm_package_version`, so
    // package.json is the single source of truth — any literal in a doc is a
    // check that fails by construction on every build after the next bump.
    expect(offenders(/v3\.\d+\.\d+/)).toEqual([]);
  });

  it("does not list limitations the repo has since lifted", () => {
    const shipped = [
      "src/app/api/v1/orgs/[orgId]/invitations/[invitationId]/route.ts",
      "src/components/okrs/okr-board.tsx",
      "src/components/intervals/intervals-workspace.tsx",
    ].filter((f) => existsSync(join(ROOT, f)));
    // Guards the guard: if these are ever removed, the limitations become true
    // again and this assertion must not keep passing silently.
    expect(shipped).toHaveLength(3);

    const guide = doc("docs/VALIDATION-GUIDE.md");
    expect(guide).not.toMatch(/No DELETE\/cancel invitation endpoint/);
    expect(guide).not.toMatch(/won't function at runtime/);
    expect(guide).not.toMatch(/\*\*Sprint-complete UI\*\*/);
  });
});

describe("validation-doc scorecards match the steps that remain", () => {
  /** The fenced scorecard block — the one whose last line is the grand total. */
  function scorecard(text: string): string {
    const blocks = [...text.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]);
    return blocks.find((b) => /^(?:Total|TOTAL)\b/m.test(b)) ?? "";
  }

  /** `_/7` or `X/7` style tallies, in document order (grand total last). */
  function tallies(text: string): number[] {
    return [...scorecard(text).matchAll(/[_X]\/(\d+)/g)].map((m) => Number(m[1]));
  }

  it("the AI-chat scorecard rows sum to its stated total", () => {
    const counts = tallies(doc("docs/AI-CHAT-TEST-PLAN.md"));
    expect(counts.length).toBeGreaterThan(2);
    const total = counts.pop()!;
    expect(counts.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it("the settings scorecard rows sum to its stated total", () => {
    const counts = tallies(doc("docs/SETTINGS-VALIDATION-PLAN.md"));
    expect(counts.length).toBeGreaterThan(2);
    const total = counts.pop()!;
    expect(counts.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it("every numbered AI-chat step belongs to a phase the scorecard still lists", () => {
    const text = doc("docs/AI-CHAT-TEST-PLAN.md");
    const phases = new Set(
      [...scorecard(text).matchAll(/^(\d[a-c]?)\./gm)].map((m) => m[1]),
    );
    const orphans = [...text.matchAll(/^\| (\d[a-c]?)\.\d+ \|/gm)]
      .map((m) => m[1])
      .filter((p) => !phases.has(p));
    expect([...new Set(orphans)]).toEqual([]);
  });
});
