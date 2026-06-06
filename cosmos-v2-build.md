# COSMOS v2 — Research Summary + Claude Code Build Prompt

> **Design of record:** `docs/superpowers/specs/2026-06-05-cosmos-v2-replatform-design.md` (read it first — this file is the runnable build prompt derived from it).
> **What changed from the original draft:** a grounded 4-agent audit + 3 adversarial critics verified the plan against the live repo. The architecture and compliance research held up; the audit found **11 blocker-class holes** and **3 missing pillars/controls** (Identity/SSO, audit-log immutability, backup-DR). The plan below is the corrected version: **5 pillars + cross-cutting hardening**, built on the **CUI-blind egress chokepoint**, with a **unidirectional per-tenant cutover** and an explicit **gov-go-live gate**.

---

## PART 1 — RESEARCH SUMMARY (cited)

### Recommended compliance baseline (target = CMMC L2 audit-ready, honestly scoped)
COSMOS serves government and commercial customers. The target is **NIST SP 800-171 Rev 2 / CMMC 2.0 Level 2 (110 controls / 14 families) as the CUI overlay**, with NIST 800-53 Rev 5 Moderate as the architectural reference and the growth path. **CMMC L2 is a 1:1 map to 800-171 r2** and is mandatory for CUI under DFARS 252.204-7012; the DFARS final rule (Case 2019-D041, *Federal Register* Sept 10 2025) added clause 252.204-7021 effective **Nov 10 2025** (Phase 1 = Level 1/Level 2 self-assessments). Most contractors need a **C3PAO** assessment.

**Honest-scope correction (load-bearing).** "CMMC L2 audit-ready" in v2 means **the technical control subset is implemented with automated evidence + a living SSP/control-coverage matrix sufficient to hand a C3PAO real artifacts.** It does **not** claim the full OSCAL-automated eMASS/cATO package, and it explicitly flags that **~40 of the 110 practices are administrative/physical/personnel** (3.2 training, 3.9 personnel, 3.10 physical, 3.12 assessment process, parts of 3.6 IR) that **no pipeline can emit evidence for** — these need written policies/procedures + SSP narrative authored by humans. The full ATO/cATO machine (OSCAL SSP auto-gen, SAR/POA&M lifecycle, DAST, Kyverno admission, STIG scripts, the RAISE 2.0 "Big Three") is **deferred until a contract sponsors it**; the compose→Helm path keeps that upgrade mechanical.

### Reference ATO portal (RAISE 2.0 — morbidsteve.github.io/rpoc-ato-portal)
Useful as a **target shape for the eventual ATO upgrade**, not as the v1-of-v2 build: FIPS 199 M-M-M; ~325 controls (~252 Moderate); OSCAL SSP; SAR/POA&M; 8 RAISE security gates (SBOM, container scan, secrets scan are gates 2/3/4); cATO competencies = **(1) Continuous Monitoring, (2) Active Cyber Defense, (3) Secure Software Supply Chain + SBOMs** (DoD CIO cATO memo, Feb 3 2022 — "CISO-approved cATOs do not expire but can be revoked if real-time risk posture is not maintained"). v2 **seeds** the SSSC pillar (SBOM + SLSA via gates 6/7) so the cATO upgrade is additive.

### Grounded current-state findings (from the repo audit — these shape the build)
- **Agent uses commercial Claude via a spawned host `claude` CLI** (`src/lib/ai/claude-cli.ts`, authed by `~/.claude.json`) with a fragile **TEXT protocol**; **3 raw spawn paths + 3 duplicated agent loops**; **no egress chokepoint, no classification check** anywhere; every tool result is `JSON.stringify`'d back into the prompt. The host-CLI path is **un-containerizable** in a non-root image.
- **Gate #1 (user RBAC) already exists and is correct** (`executors/_ctx.ts`); the **42 executors are clean and reusable** (only the return contract changes).
- **RAG is fake** (TF token-bag, not pgvector). **DataClassification is marking-only** (zero enforcement). **`Plan==GOV` is a billing label nothing reads.**
- **Plaintext secrets in Postgres** (`User.googleRefreshToken`, `Webhook.secret`, `McpServer.env/headers`); `ApiKey`/`ScimToken` show the correct hash+prefix pattern.
- **Login is Google-OAuth-only** — no SAML/OIDC/MFA → **no gov tenant can onboard** (new Pillar 2).
- **No `output:standalone`, local-only storage, zero CI security gates, mutable-tag Actions, a `E2E_TEST_AUTH`-gated auth-bypass route, `console.log` telemetry.**
- **Poisoned migration history**: three unmerged version lines (main 3.36.4 / branch 4.4.0 / prod 4.16.0) + a duplicate-timestamp collision; **no branch equals what prod runs.**

### Gov vs commercial split (corrected — rich gov via the chokepoint, NOT amputation)
The original draft solved CUI egress by **deleting** the integration/agent layer for gov. v2 instead makes the **CUI-blind egress chokepoint the foundation**, so **one architecture serves both** and gov keeps a *rich* agent that reasons over opaque handles. The split is now **policy config + which sidecars are absent**:
- **Commercial:** Nango breadth + community M365/Workspace MCP sidecars on commercial cloud; permissive classification map.
- **Government:** provider-native gov-cloud only, in-boundary (M365 **GCC High** / US Gov Graph — DoD SRG IL4; Office 365 DoD = IL5; Google **Assured Workloads** + service-account **domain-wide delegation**); default-deny map; classifier on; **code-blocked** from Nango/Softeria/Workspace-MCP/external MCP. *Softeria has no US-Gov cloud and its `--org-mode` only widens delegated scopes — it must never touch gov data.*

### GitHub Actions DSOP toolchain → control mapping (right-sized for CMMC L2)
SAST=CodeQL (SA-11/SI-2); SCA=OSV-Scanner+Trivy fs+Dependabot (RA-5/SR-3/4); secrets=gitleaks+push-protection (IA-5/SI-7); image scan=Trivy (RA-5/SI-2); IaC=hadolint+Checkov (CM-2/6); SBOM=Syft SPDX (CM-8/SR-3, **CycloneDX as info**); sign+provenance=cosign+attest-build-provenance/SLSA (SI-7/SR-4/CM-14 — **gov uses KMS/HSM or self-hosted Sigstore; public Rekor is commercial-only**); config-assertions=SHA-pin all actions + assert `E2E_TEST_AUTH!=1` + **assert testenv route absent from prod/gov image**. **Deferred:** DAST (ZAP), Kyverno admission, kube-bench/OpenSCAP (need ephemeral env / K8s).

*(Sourcing note: Nango states 800+ APIs / 2,000+ templates, self-hostable on K8s/Docker, SOC 2 Type II / HIPAA / GDPR — **confirm OSS/self-host vs paid-cloud feature boundary before committing.** RAISE 2.0 figures confirmed from the named portal.)*

---

## PART 2 — THE CLAUDE CODE BUILD PROMPT (copy-paste ready)

> **Paste everything below into Claude Code at the root of the new `cosmos-v2` repo. Full detail is in `docs/superpowers/specs/2026-06-05-cosmos-v2-replatform-design.md` — read it before planning.**

---

You are the lead engineer building **COSMOS v2**, a **true replatform** of the existing multi-tenant SaaS `cosmos-saas` (Next.js + TypeScript + Prisma, ~99.5% TS) serving **both government and commercial** customers. v2 lives in a **fresh `cosmos-v2` repo** that borrows v1 code, then **cuts over per-tenant** and retires v1. The defining constraint: a **fail-closed CUI-blind egress chokepoint** is the foundation of the agentic layer — the commercial model (Claude) orchestrates but **no CUI byte ever reaches its context**.

### STEP 0 — READ FIRST, THEN PLAN (do not write code yet)
1. Read the design spec `docs/superpowers/specs/2026-06-05-cosmos-v2-replatform-design.md` in full, plus (in the `cosmos-saas` checkout) `CLAUDE.md`, `AGENTS.md`, `prisma/schema.prisma`, and `src/lib/ai/`, `src/lib/integrations/`, `src/lib/auth/`. Summarize: how the agent makes tool calls today, the three spawn paths + three agent loops, the tenancy model, the Google OAuth flow, and the borrowable-code ledger (Appendix A).
2. Produce a written **implementation plan** mapped to the phases below, file-by-file, before any code. Stop and present it.
3. Maintain two living sections: **"Open questions / needs my input"** and **"Assumptions I believe may be mistaken"** — surface, don't silently fix, my decisions.

### CROSS-CUTTING INVARIANTS (enforce in every phase; test each)
- **No CUI to the commercial model.** Every one of the **7 ingress paths** (system prompt, user prompt, tool-result echo, MCP results, error/debug payloads, streamed deltas, persistent-pool context) routes through `src/lib/ai/egress/` or is eliminated. The withhold decision is driven by **data classification (project/entity/attachment), NOT tenant class.**
- **Detector-not-declassifier:** the in-boundary classifier may turn allow→deny, **never** deny→allow. Deterministic field-policy default-deny is the floor. Test-enforced.
- **Single egress path:** ESLint `no-restricted-imports` + an arch test make the provider module reachable only via `egress/`. Consolidate the 3 loops + 3 spawn paths **first**.
- **`tenantClass` is NOT NULL, default `gov`** (fail-closed). Gov is code-blocked from Nango/MCP/breadth/stateful-pool. Assert zero NULL `tenantClass` before any org serves traffic.
- **Secrets out of images & out of the DB:** Prisma stores only token **references** (`tokenRef` vault handle + fingerprint), never raw tokens. No secrets baked into images.
- **End users never handle client IDs/secrets** — they only click "Connect" and consent. All provider OAuth app creds are platform-side.
- **Runtime = cloud-agnostic Docker Compose** (base + commercial + gov overlays). Helm/K8s is documented, not built.
- **Audit/egress logs are append-only + retained 3yr** (gov); raw CUI never written to logs/telemetry.

### THE GOV-GO-LIVE GATE (no gov tenant cuts over until ALL are live + leak-tested)
`chokepoint(single-path, fail-closed, 7 paths) ∧ in-boundary classifier ∧ field-level default-deny map ∧ tenantClass default-gov ∧ SSO/SAML/OIDC + MFA ∧ audit immutability+retention ∧ backup/DR ∧ MCP fenced (native-executors only) ∧ red-team/golden-egress suite GREEN.` Commercial tenants may cut over earlier behind a permissive policy.

---

### PHASE 0 — CONSOLIDATE + CONTAINERIZE FOUNDATION (the highest-leverage unlock)
This unblocks **both** containerization and the chokepoint. Before coding, restate the plan.
- Add `output: "standalone"` to `next.config.ts`. Build multi-stage, **amd64-only**, `node:20-bookworm-slim`, non-root, digest-pinned, `HEALTHCHECK → GET /api/health`. Build ARG `NEXT_PUBLIC_APP_VERSION`; `NODE_OPTIONS=--max-old-space-size=4096`; bundle `prisma/migrations`.
- **Rebuild model invocation on the Anthropic SDK** keyed by `ANTHROPIC_API_KEY`, **native `tool_use`** (drop the `TOOL_CALL:` text protocol), **stateless per turn** (no resident subprocess, no Anthropic-side session retention). Collapse `callClaudeCli` + `callClaudeCliStreaming` + `cli-pool.sendMessage` into **one provider module behind `src/lib/ai/egress/`**. Unify the 3 agent loops into one.
- **Drop `--mcp-config`** — re-implement the MCP servers you actually need as **native executors** dispatched through `executeTool` so all results hit the gate.
- Insert `egress/` as a **pass-through gate with logging only** — **commercial-only by code; the gov overlay's gate is fail-closed from day one.** Prove single-path with lint + arch test.
- **Acceptance:** `docker compose up` brings up `cosmos` + `cosmos-migrate` + `cosmos-postgres` + `chokepoint` + `reverse-proxy` healthy; arch test proves no caller reaches the provider except via `egress/`; no `--mcp-config` anywhere.

### PHASE 1 — EGRESS GATES + CLASSIFIER LIVE
- Field-level `(org, entityType, field)` **exposability map, default-deny**; port `rankOf`/`minLevel`/`effectiveCeiling` from `456805a`; enforce at the chokepoint. Chokepoint pipeline: resolve `RBAC ∩ AgentPolicy ∩ Classification` → structural projection → classifier tripwire → opaque handles → fail-closed → log `EgressDecision`.
- **In-boundary `classifier` sidecar** (MiniLM/BGE via ONNX, CPU) = DLP tripwire + pgvector embeddings substrate. Detector-not-declassifier (test).
- **Structured channel/history context** — each of the 25/50 messages becomes `{authorHandle, opaqueRef, classification}`; ≥FOUO withheld by field policy *before* the classifier.
- **Sanitize error/debug payloads** — model view gets a typed code + non-CUI message; raw → audit/user view only.
- **Acceptance:** golden-egress suite green for the §11 cases (MCP interception, error echo, classifier-down fail-closed, commercial-org-holding-CUI-project still withheld, stderr/debug leak).

### PHASE 2 — HANDLES + REAL RAG OVER CUI
- `{modelView, userView}` split across the 42 executors; full CUI renders to the UI, receipts+handles to the model. `semantic_search` returns `{type,id,similarity,opaqueRef}` only. Mutation confirmations return `{success,id,opaqueRef}` (never subject/summary/body).
- **Handles scoped to (user, conversation, short TTL), in-boundary-resolve-only**; **write-path taint rule** (a value from a ≥FOUO handle cannot be written to a lower-classification field).
- **Replace fake RAG** with pgvector + in-boundary embeddings; keep `executors/rag.ts` RBAC scoping. Rebuild `process_transcript` as an in-boundary macro-tool. Build out the **macro-tool catalog** enough that common gov workflows work end-to-end.

### PHASE 3 — IDENTITY/SSO + AGENTPOLICY (thin slice) + GUI CONFIG
- **SSO (gov blocker):** generic **OIDC + SAML 2.0 SP**, per-tenant IdP config, **phishing-resistant MFA / PIV-CAC for gov** (IA-2), IdP-assertion→`OrgMember` mapping, finish inbound SCIM.
- **AgentPolicy (3-axis thin slice):** `AgentPolicy` model + `AGENT_POLICY_MANAGE` bit; axes = capability/tools, tool-arg constraints (`fetch_url` allowlist, `send_email` internal-only), data-domain. Property test: `AgentPolicy ∩ Classification` can only narrow.
- **GUI config store** (Prisma, secrets **AES-256-GCM envelope-encrypted, KMS-pluggable**): enabled connectors, per-`(tenant,provider)` auth model, provider OAuth creds (encrypted, platform-side), Nango/MCP toggles, **gov designation with guardrails** (flip to gov disables Nango/MCP/pool, forces default-deny). RBAC: platform-owner vs tenant-admin (`OrgMember.permissions` BigInt — project out of `success()`). Fail-fast zod env contract. **No redeploys.**

### PHASE 4 — HYBRID CONNECTORS + BREADTH
- **`Connection` model** (hash+prefix template) + **`getCredential` resolver** hiding delegated / Entra-app-perms / Google-DWD behind one interface (DocuSign JWT-grant = the org-app template). Drop `User.googleRefreshToken`; re-vault all plaintext secrets. Split login-auth from data-authorization.
- **Native top-N behind the fence:** Google, **M365** (Entra delegated + app-perms), **Slack, GitHub**. Reuse the SSRF guard (**resolve-then-recheck DNS**) on connector + MCP URLs.
- **Breadth (commercial-only):** Nango self-hosted; `nangoConnectionId → Connection.tokenRef`. **Gov code-blocked** from all breadth/MCP — assert with tests.

### PHASE 5 — DSOP PIPELINE + EVIDENCE + LIVING SSP (CMMC L2, honest scope)
- Add gates to `security.yml`: **SAST** (CodeQL), **SCA** (OSV+Trivy+Dependabot, fail-on-Critical, High→POA&M), **secret scan** (gitleaks + push protection), **image scan** (Trivy, fail-on-Critical), **IaC** (hadolint+Checkov), **SBOM** (Syft SPDX hard / CycloneDX info), **sign+provenance** (cosign + attest-build-provenance; **gov = KMS/HSM or self-hosted Sigstore**), **config-assertions** (SHA-pin all actions; `E2E_TEST_AUTH!=1`; **testenv route compile-excluded + asserted absent** from prod/gov image). Each gate emits `evidence/<sha>/…` + the control mapping.
- **Living SSP:** `compliance/ssp/control-coverage.csv` (all 110 practices; non-technical rows marked `policy-required, not-yet-authored`) + `SSP.md` + a `compliance-sync` job mirroring evidence into `ComplianceControl.evidence` + a `check:control-coverage` CI gate. Add the **Cloud Customer Responsibility Matrix** for GCC-High / Assured Workloads.

### CROSS-CUTTING HARDENING (land alongside the relevant phase; gov-go-live deps)
- **Audit immutability (AU-9/11):** append-only `AuditLog` + `EgressDecision`; remove Organization `onDelete:Cascade`; hash-chain/sign batches; 3yr retention; classification-aware `summarizeArgs`.
- **Backup/DR (CP-9/10):** WAL archiving + nightly base backups to an **in-boundary** target for gov; stated RPO/RTO; periodic restore-drill (CA-7).
- **Rotation (IA-5/SC-12):** DEK re-wrap, provider-credential rotation, `ANTHROPIC_API_KEY` rotation, **provider-side revoke** of migrated Google tokens.
- **Observability (SI-4/AU-6):** OTLP traces/metrics, per-sidecar health, **alert on chokepoint fail-closed rate + classifier-down**; in-boundary sink for gov.

### CUTOVER (unidirectional, per-tenant — never a global hard flip)
1. **Pin prod:** `pg_dump --schema-only` the live prod DB + copy its `_prisma_migrations`; record the prod commit SHA. Reconstruct the **superset baseline** to match that dump (start from `456805a`, add 4.4.0 chat-bot models); emit one `0000_init`. **Validation HARD gate:** `migrate diff` against the restored prod snapshot is empty **and** `data_classifications.project_id` FK present. **Never copy `_prisma_migrations`** into v2.
2. **Logical ELT from a consistent snapshot** (`pg_export_snapshot`), FK-topological order, UUID PKs preserved; enumerate FKs (UUID-on-UUID), handle self-referential/circular with deferred constraints / two-pass; exclude+recompute `content_tsv` + `searchVector`.
3. **Credentials: COPY not move** into the vault; keep prod columns intact until the org's flip is permanent; provider-side revoke after.
4. **DataClassification transform:** dedupe `(org, NULL)` ceilings keeping highest rank (log + sign-off) **before** the partial unique index; carry `markings[]` + `handlingInstructions` **verbatim**.
5. **Money:** apply Float→Decimal in a **prior** deploy; verify **per-row** (`==round(float,4)`) + row counts, not aggregate SUM.
6. **Per-tenant `freeze → migrate → verify → flip`** (commercial first, gov last behind the gate). Soak sync = **per-model idempotent UPSERT replay** (append-only by `createdAt`+PK; mutable by `updatedAt`; 37/69 models lack `updatedAt`). **No bidirectional CDC.** Rollback = re-route to v1 + restore the org from its pre-flip snapshot. For gov, shadow the data layer only — **never invoke the model for gov orgs during soak.**

### DELIVERY MODE & ACCEPTANCE
Deliver in phase order. For each phase: restate the plan before coding; after coding, list what changed + how to test. **Acceptance per phase** is in the spec (§4.8, §6, §7, §8, §9). End every phase with the updated **"Open questions"** + **"Assumptions I believe may be mistaken."** Keep `CLAUDE.md`/`AGENTS.md` current.

**Deliberately deferred (do NOT build in v1-of-v2):** multi-arch; CycloneDX as a hard gate; Paragon; Vault as a co-equal crypto path; the full 10-axis AgentPolicy; the full ATO/cATO machine (OSCAL/eMASS, SAR/POA&M lifecycle, DAST, Kyverno, STIG scripts). The compose→Helm path keeps these mechanical when a contract sponsors them.
