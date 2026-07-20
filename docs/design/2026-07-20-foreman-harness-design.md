# Foreman Project- & Subscription-Aware Harness — Design

**Status:** approved design, pre-implementation (2026-07-20)
**Scope:** one subsystem — give Foreman's *build agents* per-build skills, a project system prompt, MCP tools, and hooks, all **managed from the Foreman console (UI-first)**. Not the supervisor (shipped) and not Approach B (durable state-graph — deferred to a separate incremental effort).

## Goal

Make every Foreman build agent **consistently project-aware** (it stops re-deriving the cosmos-v2 codebase each build) and **org-customizable**, by loading Agent Skills + a project system prompt + MCP tools + safety hooks through the Claude Agent SDK's `query()` options. Everything configurable — skills (create/import), MCP servers (add), and the per-org config — is done in the **console UI**, backed by the DB. No hand-edited repo files, no env vars.

## Feasibility (confirmed)

`@anthropic-ai/claude-agent-sdk` **v0.3.206** (Foreman's pinned version) supports, all **per-`query()` call** (so per-org in one process):
- `settingSources: ["project"]` — loads `.claude/skills/` + `.claude/CLAUDE.md` from the `cwd`.
- `skills: "all" | string[]` — which skills are available (auto-adds the `Skill` tool).
- `systemPrompt: { type:"preset", preset:"claude_code", append }` or a custom string.
- `mcpServers: Record<string, McpServerConfig>` — stdio / http / in-process (`createSdkMcpServer`).
- `hooks: { PreToolUse: [...], PostToolUse: [...] }`.
- `plugins: [{ type:"local", path }]`.

Foreman calls `query({ prompt, options })` in `scripts/foreman/agent.mts` (current options: `cwd/model/maxTurns/permissionMode/allowedTools/env/abortController/resume`), with `cwd` = the per-build git worktree.

## Architecture — two layers, assembled per build

**Source of truth = the DB, managed in the console.** Nothing is hand-edited in the repo or env.

1. **Project layer** (applies to every build): DB rows with `orgId = NULL`. Seeded with an initial cosmos-v2 skill set + code-defined MCP tools + code-defined hooks. The seeded skills are editable in the UI thereafter.
2. **Per-org overlay** (additive): DB rows with `orgId = <org>` — extra skills, extra (http) MCP servers, a system-prompt append. **Never removes** the project layer's skills/hooks (safety floor).

**Build-time flow** (per build, in `agent.mts` via a new `src/lib/foreman/harness.ts`):
1. If the org's harness is disabled → skip (no harness options; behaves as today).
2. Fetch applicable skills = `(orgId IS NULL OR orgId = org) AND enabled`; **materialize** each into the ephemeral worktree at `<worktree>/.claude/skills/<name>/SKILL.md`. (The worktree is torn down after the build, so this never pollutes the persistent repo.)
3. Fetch applicable MCP servers (http-only, enabled); unseal their headers; build `mcpServers`.
4. Build `systemPrompt` = preset `claude_code` + append (the foreman brief + the org's `systemPromptAppend`).
5. Attach the code-defined project `hooks`.
6. Spread `{ settingSources:["project"], skills:"all", systemPrompt, mcpServers, hooks }` into the existing `query({options})`, and **extend** `allowedTools` with `mcp__<server>__*` + `Skill` (additive).

The **option assembly** (given fetched skills/servers/settings → the options fragment) is a **pure, unit-tested** function; the DB fetch + fs materialization + unseal is the IO wrapper.

## Data model (Prisma — one additive migration)

```prisma
model ForemanSkill {
  id           String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId        String?  @map("org_id") @db.Uuid   // NULL = project-wide
  name         String                              // slug → .claude/skills/<name>/
  description  String
  body         String                              // full SKILL.md (incl. frontmatter)
  enabled      Boolean  @default(true)
  source       String   @default("authored")       // seeded | authored | imported
  createdById  String?  @map("created_by_id") @db.Uuid
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")
  org Organization? @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@unique([orgId, name])
  @@map("foreman_skills")
}

model ForemanMcpServer {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String?  @map("org_id") @db.Uuid    // NULL = project-wide
  name        String                               // slug → mcp server key
  url         String                               // HTTP(S) ONLY (no local commands)
  headers     Json?                                // vault-sealed
  enabled     Boolean  @default(true)
  createdById String?  @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  org Organization? @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@unique([orgId, name])
  @@map("foreman_mcp_servers")
}

model ForemanHarnessSettings {
  id                 String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId              String   @unique @map("org_id") @db.Uuid
  enabled            Boolean  @default(true)
  systemPromptAppend String?  @map("system_prompt_append")
  updatedById        String?  @map("updated_by_id") @db.Uuid
  createdAt          DateTime @default(now()) @map("created_at")
  updatedAt          DateTime @updatedAt @map("updated_at")
  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@map("foreman_harness_settings")
}
```

## What the project layer ships with

**Seeded skills** (authored here, then UI-editable):
- `cosmos-architecture` — Next/Prisma/foreman layout + key modules.
- `cosmos-prisma-migrations` — the offline `migrate diff --from-schema` pattern, additive-only rules, `prisma generate`.
- `cosmos-testing` — vitest, pure-core/IO split, integration tests are CI-only (no local test DB).
- `cosmos-release-discipline` — the `CHANGELOG[0].version === package.json.version` invariant, SemVer bump rules, the manual PR→--admin→deploy flow.
- `cosmos-foreman-conventions` — sensitive paths (`risk.ts`), event-sourcing, the never-weaken-your-own-gates rule.

**Project MCP tools** (in-process `createSdkMcpServer`, always available):
- `changelog_check` — assert `CHANGELOG[0].version === package.json.version`.
- `schema_models` — list Prisma models/fields (stop guessing schema).
- `ticket_context` — the current ticket's board/feedback context.

**Project hooks** (code-defined, always apply):
- `PreToolUse` on a version-bump commit → deny if the changelog invariant is violated.
- `PostToolUse` → advisory lint on edited files.

## Console UI (all UI-first)

- **Skills manager** — list project + org skills; **Create** (form: name + description + SKILL.md body) or **Import** (paste/upload a SKILL.md — parse its frontmatter); edit / enable / disable / delete; scope shown (project vs this org). Tips on what a skill is and how the agent uses it.
- **MCP servers manager** — **Add** (name + https URL + optional headers, sealed); enable/disable/delete; a **Test** button that pings the server. Tip: only remote http(s) MCP servers (no local commands, for safety).
- **Harness settings card** — per-org **enable**, the **system-prompt append** textarea, and a read-out of which skills/MCP are active for this org. Tips explaining each.

All three gated by `ORG_MANAGE_SETTINGS`, mirroring the supervisor/github settings routes.

## Safety invariants

- **Additive-only** — the harness can only ADD skills/tools/hooks + a prompt append; a unit test asserts the assembled `allowedTools` ⊇ foreman's base set and `permissionMode` is unchanged. Never loosens a gate.
- **UI-added MCP is http(s)-only** — no UI-supplied stdio/local-process commands (that would be arbitrary host RCE). Local/in-process MCP is code-defined only (the vetted project tools).
- **Hooks are code-only** — never user-authored (no executable code from the UI).
- **MCP secrets vault-sealed** before DB (mirrors the GitHub PAT + org-email config); unsealed only at build time.
- **Ephemeral materialization** — skills are written into the per-build worktree (torn down after), never the persistent checkout.
- `settingSources:["project"]` is used only to pick up skills + CLAUDE.md; Foreman's explicit `permissionMode`/`allowedTools` still govern (a project `settings.json` cannot loosen them — verified by test).

## Testing & rollout

- **Pure** `assembleHarnessOptions(...)` unit tests: project+org layering, additive-only `allowedTools`/`permissionMode` invariant, disabled→empty, systemPrompt-append composition, http-only MCP filtering.
- **Materialization** test (tmpdir): correct `.claude/skills/<name>/SKILL.md` structure written; unknown chars in name sanitized.
- **MCP** assembly + header unseal test.
- **API route** tests: skills/MCP/settings CRUD, `ORG_MANAGE_SETTINGS` gate, SKILL.md import-parse, https-only URL validation.
- **UI** component tests for the three surfaces.
- Migration + `prisma generate`.
- **Rollout:** ship harness **enabled by default** with the seeded project skills; per-org disable available. Validate with ONE throwaway build (watch the agent load + use a skill / call an MCP tool) before relying on it. Behavior change to builds (richer prompts/tools), not a mutating action — no dry-mode; the per-org toggle + validation build are the safety net. Ships via the manual PR→--admin→deploy path (foreman sensitive-path code + a migration).

## Explicit non-goals

- User-authored **hooks** (security). Hooks stay code-defined.
- **stdio/local** MCP via UI (RCE). UI MCP is http(s) only.
- **Approach B** (durable state-graph) — separate deferred effort.
- Removing/weakening any Foreman safety gate.
