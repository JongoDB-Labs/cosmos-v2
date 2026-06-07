# COSMOS v2 — System Security Plan (SSP)
**Framework:** NIST SP 800-171 Rev 2 (110 practices / CMMC Level 2)
**Document date:** 2026-06-06
**System version:** cosmos-v2 (branch `feat/dsop-pipeline`, v2.1.0-pre)
**Status:** LIVING DOCUMENT — machine-readable matrix at `compliance/ssp/control-coverage.csv`; `check:control-coverage` CI gate enforces freshness on every build.

---

## 1. System Description

COSMOS v2 is a multi-tenant project-management and AI-assisted workflow platform serving both government (DoD/DIB) and commercial customers. It is a containerized Next.js application deployed via Docker Compose (base + `gov` / `commercial` overlays), with a PostgreSQL database, an in-boundary content classifier/embeddings sidecar, a Caddy reverse proxy, and a MinIO object store. The `gov` overlay enforces a mandatory fail-closed egress chokepoint; the `commercial` overlay adds Nango breadth connectors (not available to gov tenants).

The system processes, stores, and routes **Controlled Unclassified Information (CUI)** — specifically CUI categories relevant to DoD contracts: technical data, personally identifiable information (PII), and sensitive business information. The CUI designation is tracked per-entity via the `DataClassification` model.

---

## 2. Authorization Boundary

```
┌────────────────────────────────────────────────────────────────────────────┐
│  COSMOS v2 AUTHORIZATION BOUNDARY                                          │
│                                                                            │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────────────┐     │
│  │  Next.js app │──▶│  42 tool     │──▶│  EGRESS CHOKEPOINT         │     │
│  │  (cosmos)    │   │  executors   │   │  src/lib/ai/egress/        │     │
│  │              │   │  (RBAC gate) │   │  • MAC ceiling (FOUO+→     │     │
│  │  PostgreSQL  │   │              │   │    withhold, any tenant)   │     │
│  │  (append-    │   │              │   │  • classifier tripwire      │     │
│  │   only audit │   │              │   │  • EgressDecision log       │     │
│  │   triggers)  │   │              │   │  • SINGLE path, arch-tested│     │
│  │              │   │              │   └───────────┬────────────────┘     │
│  │  Classifier  │◀──┤              │               │  opaque handles +    │
│  │  sidecar     │   │              │               │  non-CUI fields ONLY │
│  │  (MiniLM/   │   │              │               │                      │
│  │   pgvector)  │   │              │               │  ANTHROPIC_API_KEY   │
│  │              │   │              │               │  (SDK/HTTP only)     │
│  │  MinIO       │   │              │               │                      │
│  │  (object     │   │              │               │                      │
│  │   storage)   │   │              │               │                      │
│  │              │   │              │               │                      │
│  │  Caddy       │   │              │               │                      │
│  │  (TLS/       │   │              │               │                      │
│  │   reverse    │   │              │               │                      │
│  │   proxy)     │   │              │               │                      │
└──┴──────────────┴───┴──────────────┴───────────────┼──────────────────────┘
                                                      │
         ════════════════════════════════════════════╪═══  AUTHORIZATION BOUNDARY
                                                      │
                                                      ▼
                          ┌───────────────────────────────────────┐
                          │  Anthropic API                        │
                          │  EXTERNAL — CUI-BLIND INTERCONNECTION │
                          │  (AC-4 / SA-9 external system)        │
                          │                                       │
                          │  Receives: opaque handles, receipts,  │
                          │  tool schemas, non-CUI structural      │
                          │  metadata ONLY.                        │
                          │                                       │
                          │  NEVER receives: CUI content, FOUO    │
                          │  data, classified attachments, raw     │
                          │  PII, raw financial/contract data.    │
                          └───────────────────────────────────────┘
```

### 2.1 The Anthropic API as an External, CUI-Blind Interconnection (AC-4 / SA-9)

**The Anthropic API is EXTERNAL to the authorization boundary and is explicitly NOT in-boundary.**

The Anthropic API is treated as an external interconnection under AC-4 (Information Flow Control) and SA-9 (External System Services). COSMOS v2 enforces this via a single, fail-closed egress chokepoint (`src/lib/ai/egress/`) through which **every byte destined for the Anthropic API must pass**. The chokepoint enforces:

1. **MAC ceiling** (data-classification-driven, not tenant-driven): any value whose effective classification is FOUO or above is **withheld** from the model, regardless of which tenant is making the request. A CUI project inside a commercial org is still withheld.
2. **Structural projection**: only allowlisted fields reach the model; all other fields are substituted with opaque handles (`cui:ref/<entity>/<uuid>#<field>`).
3. **Classifier DLP tripwire** (in-boundary): may only turn allow→deny, never deny→allow. An ML false-negative cannot be the gate standing between CUI and Anthropic's API.
4. **Single-path enforcement**: an ESLint `no-restricted-imports` rule and a `vitest` architecture test (`src/lib/ai/egress/__tests__/single-path.arch.test.ts`) fail the build if any module imports the Anthropic SDK provider (`egress/provider.ts`) directly, bypassing the gate.
5. **EgressDecision audit trail**: every model-turn decision is logged to the append-only `egress_decisions` table (hashes/counts, never CUI content) — the AC-4 evidence trail.
6. **Write-path taint (persist-path information-flow enforcement)**: opaque handles let the agent move a withheld CUI value *by reference* into a later in-boundary tool call. Each handle is bound at mint time to the effective classification ceiling of the data it stands for. The mint-ceiling is enforced on **both** flow directions: (a) the **read-back gate** — resolving a handle folds its mint-ceiling (max-by-rank) into the resolving turn's result ceiling so the resolved CUI can never echo back to the model under a lower per-turn ceiling; and (b) the **persist path** — before any tool executes, if it resolves a handle minted at ceiling X into a target context (the destination project's, or the org's, effective ceiling) classified **below** X, the call is **rejected fail-closed** before execution. The CUI is never written into the lower-classification container, never reaches the model (the rejection names only the classification *levels*, never the value), and the prevented down-classification write is logged as a `handle_taint_block` decision — AC-4 evidence that an information-flow violation was stopped. This closes the residual where the agent could otherwise launder CUI *down* by filing a withheld value into an entity cleared only for a lower level.

The in-boundary classifier/embeddings sidecar (MiniLM + pgvector) is **inside** the boundary. All CUI content reasoning stays in-boundary; only opaque handles cross the AC-4 boundary — and a handle may only be resolved into a write whose target container is cleared at or above the value's mint-ceiling.

### 2.2 In-Scope / Out-of-Scope Systems

| System | In-boundary? | Notes |
|--------|-------------|-------|
| COSMOS Next.js app | YES | Core application |
| PostgreSQL (cosmos-postgres) | YES | Append-only audit; role-split |
| Classifier sidecar (MiniLM/pgvector) | YES | Gov-required; commercial-optional |
| MinIO object storage | YES | In-boundary for gov |
| Caddy reverse proxy | YES | TLS termination |
| Anthropic API | **NO** | External CUI-blind interconnection (AC-4/SA-9) |
| Nango (commercial overlay only) | NO | Token vault for commercial long-tail; not available to gov |
| External MCP sidecars (commercial only) | NO | Gov tenants code-blocked by invariant |
| Google / M365 GovCloud connectors | Partially in-boundary | Gov uses provider-native gov-cloud (GCC-High / Assured Workloads); data returned is processed in-boundary via executors before any chokepoint decision |
| Native token-auth connectors (GitHub / Jira / Slack) | External SaaS; treated like the connectors above | `availability:"all"` (gov-usable) connectors registered in the connector registry. The provider token (GitHub PAT; Jira email+API-token; Slack `xoxb-` bot token) is sealed at rest in the `connector_credentials` vault (AES-256-GCM `v2.<kid>` envelopes, SC-28 / 3.13.16) via the sealed-install path — never written to `Integration.config`, never logged, never returned to the model. The executor returns a shallow shape that the egress chokepoint projects: a **gov** tenant sees STRUCTURAL fields only (issue/PR number/key + status/timestamps; channel/message ids), while free-text content (issue summary/description/comments, message text, channel name/topic, reporter/assignee names/emails) is WITHHELD by field-allowlist default-deny. Write tools (create issue / post message) return only the created id and are re-gated structurally for gov. |
| GitHub Actions CI/CD | NO | Build pipeline; no CUI; SBOM/signature artifacts stored in GHCR |

---

## 3. Data Flow Summary — 7 Ingress Paths to the Model

All 7 model-context ingress paths route through the chokepoint. None bypass it.

| # | Path | Treatment |
|---|------|-----------|
| 1 | System prompt | Static non-CUI; passes through |
| 2 | User prompt | User-authored; rendered but not data-gated (user's own input) |
| 3 | Tool-result echo | `modelView` projection only (receipts + handles) |
| 4 | MCP tool results | **Eliminated** — `--mcp-config` absent; all MCP functionality rebuilt as native executors |
| 5 | Error/debug payloads | Reduced to typed code + non-CUI message for model; raw message to user/audit view only |
| 6 | Streamed onDelta echoes | Same projection as path 3 |
| 7 | CLI-pool resident context | **Eliminated** — SDK provider is stateless per turn; no Anthropic-side session retention |

Channel/history context is not a free-text blob — each message is a structured row `{authorHandle, opaqueRef, classification}` subject to the same projection. Messages from channels/projects with classification ≥ FOUO are withheld by field policy before the classifier runs.

---

## 4. Per-Family Implementation Statements

For full per-practice details see `compliance/ssp/control-coverage.csv`. This section summarizes the narrative for each family.

### 3.1 Access Control (AC)
Access control is implemented across three layers in series: (1) per-tool RBAC (`assertPermission()` in `src/lib/ai/executors/_ctx.ts`), (2) agent policy (discretionary, 3-axis thin slice), and (3) the mandatory classification ceiling (MAC, data-driven). The Caddy reverse proxy enforces single-point ingress with TLS. Session management enforces expiry and `httpOnly`/`Secure`/`SameSite` cookie attributes. Gov tenant code-blocks prevent use of external connectors (Nango/MCP). **3.1.3 (information flow) is the load-bearing control, implemented by the egress chokepoint.**

Administrative AC controls (3.1.9 privacy notices, 3.1.15 privileged-command procedures, 3.1.16–3.1.19 wireless/mobile) are **policy-required-not-yet-authored** — they require human-written policy artifacts outside code scope.

### 3.2 Awareness and Training (AT)
All three practices (3.2.1–3.2.3) are **policy-required-not-yet-authored**. Training program content, schedules, and tracking are policy artifacts required by the deploying organization.

### 3.3 Audit and Accountability (AU)
The `audit_logs` and `egress_decisions` tables are append-only (enforced by DB triggers that raise exceptions on UPDATE/DELETE/TRUNCATE — `prisma/migrations/20260606050000_audit_immutability/`). The `cosmos_app` DB role has REVOKE UPDATE/DELETE/TRUNCATE on both tables. FK-decoupled (org deletion no longer cascades to audit rows). Gov tenant `auditRetentionDays` is floor-enforced at 1095 days (3 years) via `GOV_AUDIT_RETENTION_FLOOR_DAYS` in the security settings API.

**Deferred (partial status):** cryptographic hash-chain / WORM anchor for tamper-evidence is designed (external Rekor anchor via the SBOM pipeline) but not yet implemented. Formal SIEM/log aggregation, automated alerting on audit-write failure, and log correlation tooling are planned for the observability phase.

### 3.4 Configuration Management (CM)
Container configuration hardening: multi-stage Dockerfile, non-root user, minimal OS packages, no SSH daemon, HEALTHCHECK. hadolint + Checkov gate on every CI run. Syft SBOM (SPDX-JSON) attached to every GHCR image as attestation — the configuration inventory. Dependabot weekly for npm/github-actions/docker ecosystems. All GitHub Actions SHA-pinned. `E2E_TEST_AUTH` asserted absent from prod builds in `security.yml`.

### 3.5 Identification and Authentication (IA)
User identity: UUID-based user/org IDs; session tokens are cryptographically random UUIDs; `ApiKey`/`ScimToken` use bcrypt hash+prefix (no raw secret storage). TLS protects credentials in transit.

**3.5.3 (MFA) is now `partial`** — an in-app **OIDC Relying Party** (`openid-client`, PKCE/state/nonce/signature-validated) is implemented (`src/lib/auth/sso.ts`, `src/app/api/auth/sso/[orgSlug]/`). Per-tenant `IdpConnection` records carry a vault-sealed client secret and an optional `requiredAcr` **AAL floor**: for GOV-class tenants, `completeSsoLogin` rejects a login whose IdP-asserted `acr`/`amr` does not satisfy the floor (the IdP — Entra ID / Okta / PingFederate — asserts the MFA / phishing-resistant factor; no in-app step-up this slice). GOV orgs may set the connection `enforced`, which makes the Google login path reject those members (`src/lib/auth/sso-enforcement.ts`) so SSO cannot be bypassed. Identity is matched on `(idpConnId, subject)`, never email (account-takeover guard); claim-derived roles are capped at ADMIN (OWNER stays human-assigned). Sessions carry assurance columns (`auth_method`, `amr`, `mfa_satisfied`). **Still `planned`:** SAML 2.0 + PIV-CAC (via an in-boundary Keycloak SAML/CAC→OIDC translation appliance) and in-app WebAuthn step-up; FIDO2/WebAuthn is the replay-resistant phishing-resistant factor (3.5.4) and the remaining **gov-go-live gate dependency**.

**Break-glass / gov lockout (AC-2):** when a GOV org enforces SSO and its IdP is unavailable, ordinary members are locked out (no local password fallback by design). The **interim recovery** is the platform-owner path: an identity on the `INTERNAL_ADMINS` allowlist is exempt from the gov SSO guard and the `/internal` surface, so it can still authenticate via Google. This is a privileged, audited break-glass credential. The **follow-on** is a hardware-key-gated (WebAuthn) local-OWNER recovery login. See `HANDOFF.md` → "Break-glass".

### 3.6 Incident Response (IR)
All three practices (3.6.1–3.6.3) are **policy-required-not-yet-authored**. Incident handling capability, tracking/reporting procedures, and IR testing require human-written policy artifacts.

### 3.7 Maintenance (MA)
All maintenance practices (3.7.1–3.7.6) are **policy-required-not-yet-authored**. 3.7.5 (MFA for remote maintenance) is `planned` — dependent on the SSO/MFA phase.

### 3.8 Media Protection (MP)
Data-at-rest encryption for PostgreSQL and MinIO is planned (application-level AES-256-GCM envelope encryption for secrets; MinIO at-rest encryption). CUI markings are persisted per-entity (`DataClassification` model) and propagated to PDF/CSV/JSON exports via `src/lib/classification/markings.ts`. Physical media practices (3.8.1, 3.8.3, 3.8.7–3.8.8) are **policy-required-not-yet-authored** or inherited from cloud provider. 3.8.5 (media transport) is **inherited** from GCC-High / Assured Workloads.

**Migration-integrity tooling (v1→v2 per-tenant cutover; adjacent to CP-10, not a control per se).** The cutover engine (`scripts/cutover/`) preserves CUI markings + money exactly across a tenant migration and is verifiable + reversible. The near-zero-downtime path: `soak-sync.mjs` (an incremental watermark delta replay that keeps v2 caught up while v1 is live — deletes are invisible to a delta by design) then, under a source write-freeze, `reconcile-org.mjs` (a final idempotent import + **delete-extras** that applies the deletes a delta can't see, by an org-scoped PK-set diff over **mutable, org-owned, non-audit** tables ONLY — **never** append-only/audit tables, **never** the shared referential-closure parents (a global built-in / a user in two orgs), **never** another org's rows — children-before-parents in one owner transaction with an in-transaction orphan probe that rolls the whole reconcile back on any dangling FK) then the `verify-org` hard gate. Synthetic-tested in Docker (`npm run cutover:soak-acceptance`). BUILD-ONLY today (the runbook `docs/runbooks/cutover.md` carries the never-run-vs-prod-without-sign-off banner). See §3.7 / the 3.8.9 control-coverage note for the full description.

**Cutover flip orchestration (completes the operable suite; still TOOLING, not a control).** A dedicated **cutover reverse proxy** (`compose/cutover-proxy/`, a separate Caddy from the app proxy) routes by `orgSlug` path prefix to **v1** (source, default) or **v2** (target, after flip) and enforces the per-org **write-freeze at the edge** (405 on mutating verbs for a frozen org; reads pass) — necessarily at the proxy because the v1 source stack lacks v2's in-app freeze middleware. `scripts/cutover/lib/proxy-control.ts` drives the Caddy admin API with an idempotent desired-state model (full-config `POST /load`: atomic, zero-downtime, auto-rollback). `scripts/cutover/orchestrate.mjs` sequences the whole per-tenant procedure — **parity precheck → soak → freeze → reconcile → verify-gate → flip → unfreeze** — reusing the existing tools unchanged. It is **safe-by-default**: `--dry-run` is the default (prints the plan, touches nothing); `--confirm` is required to execute; **any failure at/after the freeze rolls the org back to v1 + unfreezes** (never left frozen or half-flipped) and prints the data-restore (pre-flip v1 snapshot) step before exiting non-zero. Synthetic-tested in Docker (`npm run cutover:acceptance-orchestrate`: pre-flip→v1, freeze→405-on-writes/200-on-reads, gate-pass, flip→v2, other-org unaffected, a forced verify failure→rollback-to-v1, dry-run-noop). BUILD-ONLY (the §A `--confirm`-required banner in the runbook).

**Pre-flip restore-point capture + validated PITR restore (CP-9 / CP-10 — the cutover data rollback is now a *tested, precise* target, not a printed instruction).** Building on the pgBackRest WAL-archiving repo (CP-9) and the tested-restore drill (CP-10, `scripts/dsop/restore-drill.sh`), the cutover now captures and pre-validates the *exact* pre-flip rollback point. **(1) Capture** — `scripts/cutover/snapshot-capture.mjs` runs on the TARGET right before the flip: `SELECT pg_create_restore_point('<label>')` stamps a NAMED PITR target into the WAL and returns its LSN; it also captures server `now()` + the timeline and (when a `--pgbackrest-exec` prefix is supplied) triggers an **incremental pgBackRest backup** so the WAL up to the restore point is archived, recording the backup label. The snapshot record `{label, lsn, restorePointTime, stanza, timeline, capturedAt, backupLabel?}` is persisted into the cutover run `--state`. The *only* write is a WAL restore-point record — no tenant table is mutated. **(2) Validate** — `scripts/dsop/restore-to-point-drill.sh --target-name <label> | --target-time <ts>` restores that exact point into a **SCRATCH** cluster (the live cluster is NEVER touched), asserts it promoted **at/after the target** (an unreachable target stays in recovery → FAIL), and runs the verification query (row counts; **`audit_logs` present**) → `RESTORE-TO-POINT: PASS`. This is the pre-flip *"rollback would work"* evidence: in a synthetic run, rows written **after** the captured point are **absent** in the scratch restore (PITR stopped at the point). **(3) Rollback** — `orchestrate.mjs` wires capture (Step 5b) + optional validate (`--validate-snapshot`, Step 5c) **after** the verify-gate and **before** the flip; on any failure at/after the freeze it re-routes to v1 + unfreezes (the **executed, NON-DESTRUCTIVE** primary rollback) and **emits the EXACT pgBackRest PITR restore command** for the captured point (`pgbackrest --stanza=<stanza> --type=name --target=<label> --target-action=promote --delta restore`, plus a `--type=time` fallback). A DB restore is **destructive**, so the orchestrator **NEVER auto-runs it** — it only emits the precise command for an operator to run deliberately (the pure builder in `scripts/cutover/lib/snapshot.ts` *refuses to emit a targetless restore*, which would replay to end-of-WAL rather than to the point — unit-tested). Synthetic-tested in Docker (stanza-create + base backup; capture creates the restore point + records the state; post-capture rows inserted; restore-to-point drill into scratch EXCLUDES the post-capture rows + verify passes; orchestrator dry-run shows the capture step + the precise restore command in its rollback plan). BUILD-ONLY; the live cluster is never restored by automation.

### 3.9 Personnel Security (PS)
Both practices (3.9.1–3.9.2) are **policy-required-not-yet-authored**. Personnel screening and separation procedures are HR/legal policy artifacts required by the deploying organization.

### 3.10 Physical Protection (PE)
All six practices (3.10.1–3.10.6) are **policy-required-not-yet-authored**. For hosted cloud deployment, physical controls are inherited from the cloud provider (GCC-High / Assured Workloads); the deploying organization must document that inheritance and any supplemental controls.

### 3.11 Risk Assessment (RA)
3.11.2 (vulnerability scanning) is **implemented** via the CI pipeline: Trivy SCA (filesystem + image scan), OSV-Scanner, CodeQL SAST, Dependabot. Evidence artifacts written to `evidence/<sha>/` on every build. 3.11.1 (risk assessment process) and 3.11.3 (remediation SLA) require policy artifacts.

### 3.12 Security Assessment (CA)
3.12.4 (SSP) is **implemented** — this document plus `control-coverage.csv`, enforced by the `check:control-coverage` CI gate. 3.12.2 (POA&M) is **partial** — security.yml auto-generates High-CVE POA&M artifacts; formal POA&M lifecycle management not yet implemented.

**Current open POA&M items:**
1. **5 Critical image CVEs** surfaced by the Trivy image-scan gate (base-image/dep vulnerabilities). These are HARD-fail in CI — the current GHCR image was built before the gate was hardened. Remediation: Dependabot base-image bumps + dep updates + re-pin base image digest.
2. **Deferred audit hash-chain/WORM anchor** (AU-9 tamper-evidence): design complete (Rekor/transparency anchor reusing the SBOM pipeline); implementation deferred to the backup/DR phase.
3. **SSO/MFA partial** (IA-2/3.5.3): in-app OIDC RP + GOV AAL-floor (acr/amr) shipped; SAML/PIV-CAC (Keycloak appliance) + in-app WebAuthn step-up (3.5.4 replay-resistant) still planned; remaining gov-go-live gate dependency.
4. **FIPS-validated crypto not yet validated** (3.13.11): Node.js FIPS mode not yet tested; planned for gov-hardening phase.
5. **Data-at-rest encryption** (3.13.16/3.8.9): application-level envelope encryption and MinIO at-rest encryption planned; not yet implemented.

3.12.1 and 3.12.3 (formal assessment process, continuous monitoring program) are **policy-required-not-yet-authored** — the CI gate provides technical CONMON but the formal program requires human-authored procedures.

### 3.13 System and Communications Protection (SC)
The Caddy reverse proxy enforces TLS at the external boundary. Internal services communicate on an isolated Docker internal network. The SSRF guard (`src/lib/security/webhook-url.ts`) blocks SSRF on all outbound webhook/connector URLs. The egress chokepoint prevents CUI information flow to the external model (AC-4). Session tokens use `httpOnly`/`Secure`/`SameSite` attributes. Gov tenants are code-blocked from external MCP sidecars and Nango.

Administrative SC practices (3.13.7 VPN/split-tunneling, 3.13.12 collaborative-device activation, 3.13.14 VoIP) are **policy-required-not-yet-authored**.

### 3.14 System and Information Integrity (SI)
The CI pipeline provides automated vulnerability identification (3.14.1/3.14.2): Trivy SCA + image scan, OSV-Scanner, CodeQL SAST, Dependabot, gitleaks. Critical CVEs are HARD-fail (block promotion); High CVEs generate POA&M artifacts. The in-boundary classifier serves as the real-time DLP tripwire for the AI path (3.14.6 partial).

---

## 5. Cloud Customer Responsibility Matrix

| Control Area | Cloud Provider Responsibility | COSMOS v2 Responsibility |
|-------------|------------------------------|--------------------------|
| **Physical security** | GCC-High / Assured Workloads: physical data center, hardware, environmental controls | None (hosted); on-prem deployers must document |
| **Hypervisor/host OS** | Cloud provider | None (managed compute) |
| **Network infrastructure** | Cloud provider (VPC/VNet isolation, DDoS, backbone) | Docker internal network; Caddy TLS; SSRF guard |
| **Storage encryption at rest** | Cloud provider volume/disk encryption | Application-level envelope encryption (planned); MinIO at-rest (planned) |
| **Data backups** | Cloud provider snapshots (if enabled) | pgBackRest WAL archiving to in-boundary target (planned for backup/DR phase) |
| **Identity infrastructure** | GCC-High/Okta/Entra managed service | COSMOS session management; SSO integration (planned) |
| **Audit log immutability** | Cloud provider CloudTrail/audit (platform events) | COSMOS append-only DB triggers; gov retention floor |
| **CUI content control** | N/A (cloud sees encrypted blobs or no CUI) | Egress chokepoint; classification markings; DLP classifier |
| **Vulnerability management** | Cloud provider CVEs in managed services | COSMOS app/image CVEs via Trivy/OSV/CodeQL/Dependabot |
| **Incident response** | Cloud provider (platform incidents) | COSMOS IR plan (policy-required-not-yet-authored) |
| **Personnel screening** | Cloud provider for their employees | Deploying organization for COSMOS operators |

---

## 6. Explicit Scope Statement

### What this SSP covers (technical controls)
This SSP documents the **technical security controls** implemented in the COSMOS v2 codebase and CI/CD pipeline. These controls are implemented, evidenced, and CI-gate-enforced:
- The CUI-blind egress chokepoint (AC-4): single-path, fail-closed, arch-tested
- Per-tool RBAC (AC-3/AC-6): 42 executors, assertPermission(), least-privilege DB role
- Append-only audit logging + gov retention floor (AU-2/AU-3/AU-9/AU-11): DB triggers, role-split, 1095-day floor; in-DB hash-chain (per-row sha256 linked list) + offsite WORM anchor; AU-11 sanctioned owner-only retention-purge with a signed chain-checkpoint (verify_audit_chain re-anchors at the checkpoint so the chain stays verifiable across the purge boundary — the app still cannot delete audit rows)
- SAST/SCA/secrets/image scan pipeline (RA-5/SI-2): CodeQL, Trivy, OSV, gitleaks, Dependabot
- Container configuration hardening + SBOM + code signing (CM-6/SR-3/SR-4): hadolint, Checkov, Syft, cosign
- In-boundary content classifier / DLP tripwire (SI-4): MiniLM + pgvector, detector-not-declassifier
- SSRF guard (SC-7/3.13.1): webhook-url.ts, gov external-connector code-block
- TLS / single-ingress reverse proxy (SC-8/3.13.8): Caddy, internal Docker network

### What this SSP does NOT cover (policy-pending)
Approximately **38 administrative, physical, personnel, and process practices** across families AT (3), IR (3), MA (6), PE (6), PS (2), and portions of AC/CM/RA/CA/SC are marked **`policy-required-not-yet-authored`** in the control matrix. These require:
- Human-authored written policies and procedures
- Training program content and tracking records
- Physical facility documentation (for on-prem deployments)
- Formal risk assessment records
- Incident response plan and tabletop exercises
- Personnel screening and separation procedures

**A C3PAO assessment for CMMC Level 2 certification additionally requires all of those written policies and procedures, plus demonstrated practice, before a Certificate of CMMC Status can be issued.** This SSP + the technical evidence artifacts are a necessary but not sufficient condition for full CMMC L2 certification.

### Current POA&M Items
See §4.12 above. Five items are open; none are ignored — they are tracked and CI-visible.

---

## 7. Revision History

| Date | Version | Author | Change |
|------|---------|--------|--------|
| 2026-06-06 | 2.1.0-pre | COSMOS Agent | Initial living SSP — Task 3 of DSOP pipeline |
| 2026-06-06 | 2.2.0-pre | COSMOS Agent | SSO phase 1 (in-app OIDC RP): IA-2/3.5.3, 3.5.4, 3.7.5 + SSO POA&M moved planned→partial; gov AAL floor + enforced-SSO guard + break-glass documented |
| 2026-06-07 | 2.17.0 | COSMOS Agent | Cutover near-zero-downtime: incremental soak-sync (watermark delta replay) + final reconcile (delete-extras, orphan-safe, never-delete invariants) — migration-integrity tooling note added to MP/3.8.9 |
| 2026-06-07 | 2.18.0 | COSMOS Agent | Cutover flip orchestration: dedicated cutover reverse proxy (per-org v1/v2 routing + edge write-freeze) + proxy-control + orchestrate.mjs (parity→soak→freeze→reconcile→verify→flip→unfreeze, dry-run default, rollback on any post-freeze failure) — completes the operable cutover suite; MP/3.8.9 note extended |
