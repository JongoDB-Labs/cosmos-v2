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

The in-boundary classifier/embeddings sidecar (MiniLM + pgvector) is **inside** the boundary. All CUI content reasoning stays in-boundary; only opaque handles cross the AC-4 boundary.

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
User identity: UUID-based user/org IDs; session tokens are cryptographically random UUIDs; `ApiKey`/`ScimToken` use bcrypt hash+prefix (no raw secret storage). TLS protects credentials in transit. **3.5.3 (MFA) is `planned`** — current auth is single-factor (Google OAuth). MFA/phishing-resistant second factor (FIDO2/WebAuthn via SAML/OIDC IdP) is the next phase and a **gov-go-live gate dependency**.

### 3.6 Incident Response (IR)
All three practices (3.6.1–3.6.3) are **policy-required-not-yet-authored**. Incident handling capability, tracking/reporting procedures, and IR testing require human-written policy artifacts.

### 3.7 Maintenance (MA)
All maintenance practices (3.7.1–3.7.6) are **policy-required-not-yet-authored**. 3.7.5 (MFA for remote maintenance) is `planned` — dependent on the SSO/MFA phase.

### 3.8 Media Protection (MP)
Data-at-rest encryption for PostgreSQL and MinIO is planned (application-level AES-256-GCM envelope encryption for secrets; MinIO at-rest encryption). CUI markings are persisted per-entity (`DataClassification` model) and propagated to PDF/CSV/JSON exports via `src/lib/classification/markings.ts`. Physical media practices (3.8.1, 3.8.3, 3.8.7–3.8.8) are **policy-required-not-yet-authored** or inherited from cloud provider. 3.8.5 (media transport) is **inherited** from GCC-High / Assured Workloads.

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
3. **SSO/MFA not yet implemented** (IA-2/3.5.3): planned for next phase; gov-go-live gate dependency.
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
- Append-only audit logging + gov retention floor (AU-2/AU-3/AU-9/AU-11): DB triggers, role-split, 1095-day floor
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
