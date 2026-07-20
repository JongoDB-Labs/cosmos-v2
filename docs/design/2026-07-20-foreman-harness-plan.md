# Foreman Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Foreman's build agents per-build, UI-managed skills + project system prompt + http MCP tools + safety hooks, assembled per org and materialized into the ephemeral build worktree.

**Architecture:** DB-backed, console-managed (UI-first). A pure `harness.ts` assembles the Claude Agent SDK `query()` options fragment from applicable skills/MCP/settings; `agent.mts` materializes skills into the worktree's `.claude/skills/` and spreads the fragment into its existing `query()`. Project layer (orgId NULL, seeded) always applies; per-org overlay is additive.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, Next.js (App Router), `@anthropic-ai/claude-agent-sdk` v0.3.206 (`query`, `createSdkMcpServer`, `tool`, `HookCallback`), vitest.

## Global Constraints

- **Ships via manual PR + `--admin` merge + `deploy-migrate.sh <version>`** — foreman sensitive-path code + a DB migration. Bump `package.json` + prepend a `CHANGELOG` entry (CI asserts `CHANGELOG[0].version === package.json.version`).
- **Additive-only invariant:** the harness may only ADD skills/tools/hooks + a systemPrompt append. It must NEVER remove or loosen foreman's `permissionMode` or drop entries from its base `allowedTools`. Unit-tested.
- **UI-added MCP is http(s)-only** — the MCP `url` must match `^https?://`; no stdio/local commands from the UI (RCE). In-process MCP = code-defined project tools only.
- **Hooks are code-defined only** — never user-authored.
- **MCP header secrets vault-sealed** via `sealMcpJson`/`unsealMcpJson` (`src/lib/integrations/mcp-secrets.ts`); unsealed only at build time.
- **Skills materialized into the ephemeral worktree** (torn down after the build) — never the persistent checkout.
- Pure logic in `src/lib/foreman/*.ts` (vitest can't load `.mts`); daemon IO in `scripts/foreman/*.mts`. Migrations generated OFFLINE via `prisma migrate diff --from-schema <git HEAD copy> --to-schema <working> --script` (no DB connection).

---

# Phase 1 — Data model

### Task 1: Three Prisma models + migration

**Files:** Modify `prisma/schema.prisma` (add 3 models near `ForemanSupervisorSettings`, + 3 back-relations on `model Organization`); Create `prisma/migrations/<ts>_foreman_harness/migration.sql`.

**Produces:** tables `foreman_skills`, `foreman_mcp_servers`, `foreman_harness_settings`; prisma client models `foremanSkill`, `foremanMcpServer`, `foremanHarnessSettings`.

- [ ] **Step 1: Add the models** (verbatim from the spec's Data model section — `ForemanSkill`, `ForemanMcpServer`, `ForemanHarnessSettings`, each with `@@map` and `@@unique` as specified). Add to `model Organization`: `foremanSkills ForemanSkill[]`, `foremanMcpServers ForemanMcpServer[]`, `foremanHarnessSettings ForemanHarnessSettings?`.
- [ ] **Step 2: Generate the migration OFFLINE**

```bash
git show HEAD:prisma/schema.prisma > /tmp/old_harness.prisma
TS=$(date -u +%Y%m%d%H%M%S)_foreman_harness && mkdir -p prisma/migrations/$TS
npx prisma migrate diff --from-schema /tmp/old_harness.prisma --to-schema prisma/schema.prisma --script > prisma/migrations/$TS/migration.sql
cat prisma/migrations/$TS/migration.sql   # expect 3 CREATE TABLE + unique indexes + FKs, additive only
```
Expected: three `CREATE TABLE` statements, `@@unique` indexes, and org FKs. No DROP/ALTER of existing tables.
- [ ] **Step 3:** `npx prisma validate` → "valid"; `npx prisma generate` → generated.
- [ ] **Step 4: Commit**
```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(foreman): harness DB models (skills, http mcp servers, harness settings) + migration"
```

---

# Phase 2 — Pure assembler (`src/lib/foreman/harness.ts`)

### Task 2: Types + `assembleHarnessOptions` (additive-only)

**Files:** Create `src/lib/foreman/harness.ts`; Test `src/lib/foreman/harness.test.ts`.

**Produces:** `HarnessSkill`, `HarnessMcpServer`, `HarnessInput`, `HarnessOptions`, `assembleHarnessOptions(input: HarnessInput): HarnessOptions`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { assembleHarnessOptions } from "./harness";

const base = () => ({
  enabled: true,
  baseAllowedTools: ["Read", "Grep", "Edit", "Write", "Bash"],
  basePermissionMode: "acceptEdits" as const,
  skills: [{ name: "cosmos-testing" }, { name: "cosmos-architecture" }],
  mcpServers: [{ name: "docs", url: "https://mcp.example.com", headers: { Authorization: "Bearer x" } }],
  systemPromptAppend: "Follow cosmos conventions.",
  foremanBrief: "Build ticket COSMOS-1.",
});

describe("assembleHarnessOptions", () => {
  it("adds skills, the Skill tool, and mcp__* to allowedTools WITHOUT dropping the base tools", () => {
    const o = assembleHarnessOptions(base());
    for (const t of ["Read", "Grep", "Edit", "Write", "Bash"]) expect(o.allowedTools).toContain(t);
    expect(o.allowedTools).toContain("Skill");
    expect(o.allowedTools).toContain("mcp__docs");
    expect(o.settingSources).toEqual(["project"]);
    expect(o.skills).toBe("all");
  });
  it("never loosens permissionMode (returns the base unchanged)", () => {
    expect(assembleHarnessOptions(base()).permissionMode).toBe("acceptEdits");
  });
  it("composes systemPrompt as preset+append including the brief and the org append", () => {
    const o = assembleHarnessOptions(base());
    expect(o.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(o.systemPrompt.append).toContain("Build ticket COSMOS-1.");
    expect(o.systemPrompt.append).toContain("Follow cosmos conventions.");
  });
  it("filters out non-http MCP servers (defense in depth)", () => {
    const o = assembleHarnessOptions({ ...base(), mcpServers: [{ name: "bad", url: "stdio:///bin/sh", headers: null }] });
    expect(o.mcpServers).toEqual({});
    expect(o.allowedTools).not.toContain("mcp__bad");
  });
  it("disabled ⇒ an empty fragment that changes nothing", () => {
    const o = assembleHarnessOptions({ ...base(), enabled: false });
    expect(o.settingSources).toBeUndefined();
    expect(o.mcpServers).toEqual({});
    expect(o.allowedTools).toEqual(["Read", "Grep", "Edit", "Write", "Bash"]);
  });
});
```

- [ ] **Step 2: Run → fail** (`npx vitest run src/lib/foreman/harness.test.ts`).
- [ ] **Step 3: Implement**

```ts
// src/lib/foreman/harness.ts
/** Pure assembler for the Foreman build harness: given the applicable skills, http
 *  MCP servers, and per-org settings, produce the additive fragment merged into the
 *  Agent SDK query() options. NO I/O — agent.mts fetches the rows, materializes the
 *  skills, unseals headers, and spreads this in. The invariant this file guarantees:
 *  it only ADDS to allowedTools and never changes permissionMode. */
export interface HarnessSkill {
  name: string;
}
export interface HarnessMcpServer {
  name: string;
  url: string;
  headers: Record<string, string> | null;
}
export interface HarnessInput {
  enabled: boolean;
  baseAllowedTools: string[];
  basePermissionMode: "acceptEdits" | "default" | "plan" | "bypassPermissions";
  skills: HarnessSkill[];
  mcpServers: HarnessMcpServer[];
  systemPromptAppend: string | null;
  foremanBrief: string;
}
export interface HarnessOptions {
  settingSources?: ["project"];
  skills?: "all";
  systemPrompt: { type: "preset"; preset: "claude_code"; append: string };
  mcpServers: Record<string, { type: "http"; url: string; headers?: Record<string, string> }>;
  hooks?: unknown; // filled by the daemon (code hooks); typed there
  allowedTools: string[];
  permissionMode: HarnessInput["basePermissionMode"];
}

const HTTP = /^https?:\/\//i;

export function assembleHarnessOptions(input: HarnessInput): HarnessOptions {
  const append = [input.foremanBrief, input.systemPromptAppend].filter(Boolean).join("\n\n");
  const systemPrompt = { type: "preset" as const, preset: "claude_code" as const, append };

  if (!input.enabled) {
    return {
      systemPrompt,
      mcpServers: {},
      allowedTools: [...input.baseAllowedTools],
      permissionMode: input.basePermissionMode,
    };
  }

  const mcpServers: HarnessOptions["mcpServers"] = {};
  const mcpTools: string[] = [];
  for (const s of input.mcpServers) {
    if (!HTTP.test(s.url)) continue; // http(s) only — never a local command
    mcpServers[s.name] = { type: "http", url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
    mcpTools.push(`mcp__${s.name}`);
  }

  // ADDITIVE union — base tools always retained; add Skill + mcp__* once each.
  const allowedTools = Array.from(
    new Set([...input.baseAllowedTools, ...(input.skills.length ? ["Skill"] : []), ...mcpTools]),
  );

  return {
    settingSources: ["project"],
    skills: "all",
    systemPrompt,
    mcpServers,
    allowedTools,
    permissionMode: input.basePermissionMode, // unchanged — never loosened
  };
}
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(foreman): pure harness options assembler (additive-only)`.

---

# Phase 3 — Build integration

### Task 3: Skill materialization + applicable-rows fetch (`scripts/foreman/harness-io.mts`)

**Files:** Create `scripts/foreman/harness-io.mts`; add a pure `skillDirName(name)` sanitizer + test to `harness.ts`/`harness.test.ts`.

**Produces:** `materializeSkills(worktreeDir, skills: {name, body}[]): Promise<void>` (writes `<worktree>/.claude/skills/<safeName>/SKILL.md`); `loadHarness(orgId): Promise<{ settings, skills, servers }>` (fetch applicable rows + unseal headers via `unsealMcpJson`).

- [ ] **Step 1** Add pure `skillDirName(name: string): string` to `harness.ts` (lowercase, `[^a-z0-9-]`→`-`, collapse dashes) + a test (`"Cosmos Testing!" → "cosmos-testing"`). TDD.
- [ ] **Step 2** Implement `harness-io.mts`:
  - `loadHarness(orgId)`: `prisma.foremanHarnessSettings.findUnique`, `prisma.foremanSkill.findMany({ where:{ OR:[{orgId:null},{orgId}], enabled:true } })`, `prisma.foremanMcpServer.findMany({ where:{ OR:[{orgId:null},{orgId}], enabled:true } })`; unseal each server's `headers` with `unsealMcpJson`.
  - `materializeSkills(worktreeDir, skills)`: for each, `mkdir -p <worktreeDir>/.claude/skills/<skillDirName(name)>` and write `SKILL.md` = `body` (best-effort; log + continue on error).
- [ ] **Step 3** Verify `npx tsc --noEmit` clean. (DB/fs — validated in the Task-5 live build, not a local unit test.)
- [ ] **Step 4: Commit** `feat(foreman): harness IO — load applicable rows + materialize skills into the worktree`.

### Task 4: Wire the harness into `agent.mts` `query()`

**Files:** Modify `scripts/foreman/agent.mts` (the `query({options})` call ~L200-212).

**Interfaces:** Consumes `assembleHarnessOptions` (Task 2), `loadHarness`+`materializeSkills` (Task 3), `PROJECT_HOOKS` (Task 8).

- [ ] **Step 1** Before `query()`, when `opts.orgId`: `const h = await loadHarness(opts.orgId); await materializeSkills(worktreeDir, h.skills);` then `const frag = assembleHarnessOptions({ enabled: h.settings?.enabled ?? true, baseAllowedTools: <the split allowedTools>, basePermissionMode: <current>, skills: h.skills, mcpServers: h.servers, systemPromptAppend: h.settings?.systemPromptAppend ?? null, foremanBrief: prompt-derived brief })`.
- [ ] **Step 2** Merge into `options`: `settingSources: frag.settingSources`, `skills: frag.skills`, `systemPrompt: frag.systemPrompt`, `mcpServers: frag.mcpServers`, `hooks: PROJECT_HOOKS`, `allowedTools: frag.allowedTools`, `permissionMode: frag.permissionMode`. (Wrap in try/catch → on any harness error, fall back to today's options so a harness failure never blocks a build.)
- [ ] **Step 3** `npx tsc --noEmit` clean.
- [ ] **Step 4: Commit** `feat(foreman): build agents load the harness (skills/mcp/hooks/systemPrompt)`.

---

# Phase 4 — Seeded project content

### Task 5: Seed the cosmos-v2 project skills

**Files:** Create `scripts/foreman/seed-harness.mts` (idempotent upsert of the 5 seed skills as `orgId:null, source:"seeded"`); the 5 SKILL.md bodies inline.

- [ ] Author the 5 skills (`cosmos-architecture`, `cosmos-prisma-migrations`, `cosmos-testing`, `cosmos-release-discipline`, `cosmos-foreman-conventions`) — each a real SKILL.md with frontmatter (`name`, `description`) + body drawn from this repo's actual conventions. Upsert by `(orgId:null, name)`. Idempotent (safe to re-run). Run once at deploy. Commit `feat(foreman): seed cosmos-v2 project skills`.

### Task 6: Project MCP tools (`scripts/foreman/harness-tools.mts`)

**Files:** Create `scripts/foreman/harness-tools.mts` exporting `projectMcpServer` via `createSdkMcpServer({ name:"cosmos", tools:[...] })` using `tool(...)` from the SDK.

- [ ] Implement `changelog_check` (read package.json + changelog.ts, assert `CHANGELOG[0].version === version`), `schema_models` (parse `prisma/schema.prisma` model names/fields), `ticket_context` (given a ticket key, return its board column + linked feedback). Each `tool(name, desc, zodSchema, handler)`. Add `projectMcpServer` to the `mcpServers` foreman passes (key `cosmos`) + `mcp__cosmos` to allowedTools. tsc clean. Commit `feat(foreman): in-process project MCP tools (changelog/schema/ticket)`.

### Task 7: Project safety hooks (`scripts/foreman/harness-hooks.mts`)

**Files:** Create `scripts/foreman/harness-hooks.mts` exporting `PROJECT_HOOKS`.

- [ ] `PreToolUse` matcher `Bash`: if the command is a `git commit` on a diff that bumped `package.json` version but `CHANGELOG[0].version` doesn't match → return `permissionDecision:"deny"` with a reason. `PostToolUse` matcher `Edit|Write`: advisory (log) — no deny. Pure decision helper (`shouldDenyCommit(cmd, changelogVersion, pkgVersion)`) extracted to `harness.ts` + unit-tested. Commit `feat(foreman): project safety hooks (changelog-invariant guard)`.

---

# Phase 5 — Console UI + API (UI-first)

Mirror the supervisor settings card + its route (`src/app/api/v1/orgs/[orgId]/foreman/supervisor/route.ts`, `src/components/foreman/foreman-supervisor-panel.tsx`) and the github-panel patterns. All routes `ORG_MANAGE_SETTINGS`-gated.

### Task 8: Harness settings reader + config API + card
- [ ] `src/lib/foreman/harness-settings.ts` `getForemanHarnessSettings(orgId)` (defaults `{enabled:true, systemPromptAppend:null}`) + test. `…/foreman/harness/route.ts` GET/PUT (zod: `enabled:boolean, systemPromptAppend:string|null`). `foreman-harness-panel.tsx` (enable toggle + append textarea + read-out of active skills/MCP + tips). Mount in `foreman-console.tsx`. Tests. Commit.

### Task 9: Skills manager API + UI
- [ ] `…/foreman/skills/route.ts` GET(list project+org) / POST(create|import: `{name, description, body, orgScope:boolean}`; parse SKILL.md frontmatter on import; validate name slug) ; `…/foreman/skills/[id]/route.ts` PATCH(enable/edit) / DELETE. `foreman-skills-panel.tsx` (list; Create form; Import paste/upload; edit/disable/delete; scope badges; tips). Tests (route incl. import-parse; UI). Commit.

### Task 10: MCP servers manager API + UI
- [ ] `…/foreman/mcp-servers/route.ts` GET/POST(`{name, url, headers, orgScope}`; **reject non-https url** 422; seal headers via `sealMcpJson`) ; `…/[id]/route.ts` PATCH/DELETE ; optional `…/[id]/test/route.ts` (ping the url). `foreman-mcp-panel.tsx` (list; Add form https-only + headers; enable/disable/delete; Test button; tip: remote http servers only). Tests. Commit.

---

# Ship
- [ ] Bump `package.json` + `CHANGELOG` (`CHANGELOG[0].version === package.json`). Run `npx vitest run src/lib/foreman/ src/app/api/v1/orgs/**/foreman/**` + `npx tsc --noEmit`.
- [ ] Manual PR → CI green → `gh pr merge --squash --admin` → tag `vX.Y.Z` → `deploy-migrate.sh X.Y.Z` (migration!) → run `seed-harness.mts` once → restart foreman.
- [ ] Validation build: file a throwaway ticket, watch a build's logs confirm it loaded a skill / called an `mcp__cosmos` tool, then delete the card.

# Self-review (spec coverage)
- §Data model → Task 1 ✓ · §Pure assembler + additive-only invariant → Task 2 ✓ · §skill materialization/build flow → Tasks 3-4 ✓ · §seeded skills/MCP/hooks → Tasks 5-7 ✓ · §UI (skills/MCP/settings, UI-first) → Tasks 8-10 ✓ · §safety (additive-only, http-only, sealed, code-hooks, ephemeral) → Tasks 2,7,10,3 ✓ · §rollout → Ship ✓.
