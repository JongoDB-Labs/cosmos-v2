# Cosmos — AI-First, One-Stop-Shop Roadmap

> **Status:** Living roadmap · **Authored:** 2026-06-02 (against v3.18.0) · **Updated:** 2026-06-03 (against v3.36.2) — much of the NOW tier and the migration-gated set has since **shipped**; see the **Shipped since** callout below.
> **Method:** Grounded in a read-only inventory of the *actual* codebase (data model + API + UI + AI/integrations), then analyzed through 8 persona/sector lenses and synthesized. Every recommendation cites infrastructure that **already exists** so we extend rather than rebuild.

This document is for your review. It does **not** commit us to anything. It separates what I can ship autonomously tonight on existing infra (no schema migration, low risk) from what needs a design doc + your sign-off (schema-heavy or cross-cutting), and isolates the **integrations / MCP / webhook ideas** you asked for "at the end" into their own section.

> **✅ Shipped since this was written (v3.18.0 → v3.36.2):** Sprint/Cycle workspace + capacity (#33/#35) · Goals & OKRs — `Objective`/`KeyResult` models + routes + KR create (#37/#56) · rich-text Note editor + side-by-side live preview (#32/#68) · personal Home dashboard (#41) · feature-request/bug portal + AI auto-bug-reporting (#38/#67) · **work-role ABAC engine** — models + deny-only evaluator + `requireAccess` across ~16 routes + deny-policy authoring UI (#42/#43/#57/#58/#59) · expense approval (#40) · Partners/Products/Contracts UIs (#61/#62/#63) · Cmd-K quick-create actions (#70) · **AI bots in channels** — assistant + note-taker via `/ai`, `/notes`, `@mentions` — and project-grouped channels (#74/#71). The §3 tables and §4/§8 lists are annotated ✅ where shipped; the rest stands as proposed.

---

## 0. The headline finding

Cosmos is **far more built-out than it looks.** The biggest near-term wins are not new features — they are **wiring up production-grade backends that sit behind "coming soon" pages or 404ing clients.** Concretely, verified in code:

- **Cycle/Sprint** ✅ **done** — the production-grade backend (CRUD + capacity + a `complete` route that computes velocity and rolls incomplete items forward) is now wired to a real plan→active→complete UI (#33/#35); no longer "coming soon."
- **OKR** ✅ **done** — the built `OkrBoard`/`objective-card`/`key-result-row` UI used to 404; the `Objective`/`KeyResult` models + their routes were added (plus KR create), so it works now (#37/#56).
- `board-renderer.tsx` gated **SCRUM, BACKLOG, OKR, PORTFOLIO, RAID, ROADMAP, PROGRAM** to "Coming soon." **OKR is now live**; SCRUM/BACKLOG were assessed as too shallow to map onto Kanban without deeper sprint-scoping (deferred); PORTFOLIO/RAID/ROADMAP/PROGRAM remain stubs.
- `DashboardWidget` (+ 6 widget types + a grid engine) exists; the home page now renders a real **personal Home dashboard** (built on a new `HomeWidget` table, #41) rather than a static stat grid.
- `OrgMember.abacRules` (JSON) is ✅ **now wired** as the ABAC rule store (evaluated by `requireAccess`). `SavedReport.schedule`, `ApiKey` inbound auth, `ScimToken` inbound handler, `OrgSecuritySettings.ssoEnforced` remain **modeled but unwired.**
- `searchVector` columns exist on Notes/WorkItems/Contracts/Meetings, but RAG is still **keyword-overlap**, not real vector embeddings (the embedding swap is still isolated to one file, `embed.ts`).

So the strategy wrote itself: **activate the dormant spine, finish the stubs, then build the AI-first moat layer on top** — and much of the "activate + finish stubs" half has now shipped (see the callout above).

---

## 1. The thesis

Cosmos does not win by out-polishing Jira, Salesforce, or QuickBooks in any one quadrant. It wins by being **the one tenant where work, money, contracts, time, comms, identity, and compliance evidence already coexist in a single graph** — and a **unified AI executor layer (30+ tools) can read and act across all of it.**

The moat is **AI-first *and* breadth-first**: proactive, explainable computation over the org's *own* auto-captured data — forecasts with a reason, compliance evidence harvested from our own audit log, performance reviews drafted from actually-shipped work — that point tools **structurally cannot match because each owns only one domain.**

Sequencing principle: **build the explicit, clearly-scoped asks now on existing infra; design-doc the schema-heavy subsystems before building so they compound rather than collide.**

---

## 2. Top moat plays (highest leverage)

1. **Ubiquitous AI command bar + on-write enrichment** — surface the 30+ cross-domain executors through the *already-global* Cmd-K on every page (with page context), and turn the no-op `process_transcript` into a real meeting→ticket/summary executor. AI becomes the product, not a sidebar. Breadth of executors across PM+CRM+Finance+Time+Notes *is* the moat.
2. ✅ **Work-role ABAC engine** (activate `OrgMember.abacRules`) — **SHIPPED** (#42/#58): `requireAccess` now wraps ~16 resource-mutation routes as the single chokepoint where attribute/work-role policy slots in **once**, ready for HR approvals, Finance sign-off, A&E review to inherit. The deepest switching cost.
3. **Background-job / scheduler substrate + scheduled AI agents** — no cron/queue exists; `SavedReport.schedule` is dormant. This one primitive unlocks **proactive** AI across every lens (nightly briefs, exec digests, deal-health recompute, SLA watchers, recurring invoices). Proactive (not request/response) AI is what separates AI-first from a chatbot bolt-on.
4. **AI evidence collection + POA&M on the existing compliance graph** — auto-harvest NIST/CMMC/FedRAMP evidence from our *own* AuditLog/OrgSecuritySettings/SessionRecord. Only possible when the platform **is** the evidence source. Combined with CUI/FOUO marking + DD254, this legally gates a regulated segment that cannot use unmarked SaaS — a rare, sticky GovCon beachhead.
5. **Quote→Contract→Invoice→Payment (deal-to-cash in one tenant)** — we already own the contact, contract, DocuSign eSign, PDF export, and billable TimeEntry. Generating an invoice from approved time in-place (no QuickBooks re-keying) is the consolidation payoff and the deepest lock-in for services/ERP/A&E buyers.
6. **Cosmos *as* an MCP server** — we're already an MCP *client*; the executor registry maps 1:1 to outward MCP tools with RBAC gating built in. As enterprises standardize on MCP, being the **governed action plane** other agents call makes Cosmos infrastructure, not an app.
7. **Real vector embeddings (pgvector)** — `embed.ts` already isolates the embedding behind a one-file swap. Cross-entity semantic memory over **all** org data (notes+tickets+contracts+meetings) is a capability no point tool ships, and it's the quality floor that makes every other AI feature trustworthy.
8. **Inbound ingestion + Jira/Asana/Linear import** — the 9-provider registry advertises connectors but ships only *outbound* webhooks. Inbound + an AI-field-mapped importer lets teams adopt Cosmos **without abandoning their tracker day one** — the low-switching-cost migration on-ramp.

---

## 3. The unified roadmap (Now / Next / Later)

Tags: `kind` (complete-stub / activate-dormant / new-module / enhance) · `effort` (S/M/L/XL) · `scope` (clearly-scoped / needs-design / architectural).

### NOW
| Feature | kind | effort | scope | Lenses |
|---|---|---|---|---|
| ✅ (#33/#35) **Sprint/Cycle workspace** — cycle backend wired to a plan→active→complete UI + capacity; one-click `generate_cycle_brief` | complete-stub | M | clearly-scoped | PM |
| ✅ (#37/#56) **Goals & OKRs** — `Objective`/`KeyResult` models + routes + KR create; the built `OkrBoard` no longer 404s | complete-stub | M | clearly-scoped¹ | PM |
| ⏸ (deferred) **SCRUM + BACKLOG board views** — judged too shallow to map onto Kanban without deeper sprint-scoping | complete-stub | M | clearly-scoped | PM |
| ✅ (#32/#68) **Rich-text Note editor** — formatting + markdown + side-by-side live preview; `searchVector` preserved | enhance | M | clearly-scoped | UX |
| ✅ (#41) **Personal/role-based Home dashboard** — new `HomeWidget` table (instead of generalizing `DashboardWidget`) | activate-dormant | L | needs-design¹ | UX |
| ✅ (#38/#67) **Feature-request & bug-report portal** — voting + AI auto-bug-reporting/dedup-on-submit | new-module | M | needs-design¹ | UX |
| 🟡 (#70) **Ubiquitous AI command bar** — Cmd-K quick-create + go-to actions shipped; full "execute any executor" still open | enhance | M | clearly-scoped | UX, AI |
| ⏳ **AI data-enrichment on write** — `process_transcript` still a no-op (the chat note-taker does adjacent summarization) | complete-stub | M | clearly-scoped | AI, ERP, HR |
| ⏳ **Inbound API-key auth helper** + scope→permission map (unblocks MCP-server, inbound webhooks, marketplace) | activate-dormant | S | clearly-scoped | AI, DevOps |
| ⏳ **SCIM 2.0 inbound provisioning** (`/scim/v2/Users`+`/Groups`) | complete-stub | L | clearly-scoped | DevOps, HR |
| 🟡 **Expanded UI prefs + per-role workspace defaults** — preferences exist; per-role defaults still open | enhance | S | clearly-scoped | UX |

¹ These required an additive Prisma migration against prod; the user authorized it ("migrations OK") and they have **shipped** — see §4.

### NEXT
Work-role ABAC engine · Background-job/scheduler substrate + scheduled AI digests · SAML/OIDC SSO · POA&M + AI evidence collection · Deliverable/Milestone sign-off (+ `Milestone` model) · Quote→Invoice+line-items (PDF/eSign) · Payment + AR-aging ledger · **Money correctness: Float→Decimal migration** (gating, major bump) · Account/Deal CRM split + auto Gmail/Cal activity timeline · Cosmos-as-MCP-server · Inbound ingestion + Jira/Asana/Linear import · Recruiting/ATS (clone CRM pipeline) · RAID register + CCB · Budget vs Actuals · Expense approval + receipts · Portfolio/Program rollup + digest · Cross-org Template Library + AI template-from-project.

### LATER
AI automation/workflow rules engine · Incident & service management + on-call · Customer health scores · Performance reviews + 1:1s · Training/courses/certifications · Skills matrix + AI inference · CUI/FOUO marking enforcement + DD254 + flow-down portal · Revenue recognition schedules · Purchase Order + 3-way match + AP bill inbox · Cross-project resource heatmap · Task dependencies + critical path + baselines · Webhook delivery reliability (retry/replay/DLQ) · Privileged access reviews · Marketplace/plugin architecture · Public roadmap/changelog + composable Spaces.

---

## 4. What I'll build autonomously tonight vs what needs your sign-off

**Hard constraint I'm respecting:** the local `DATABASE_URL` is the **production** database. I will **not** run schema migrations against prod unprompted, and I will not mutate prod data. So I'm splitting "build now" by whether it needs a migration.

### ✅ Shipped — clearly-scoped, no-migration wiring
1. ⏸ **SCRUM + BACKLOG board views** — deferred (assessed as too shallow to map onto Kanban without deeper sprint-scoping).
2. ✅ **Sprint/Cycle workspace** — shipped against the production-grade cycle routes + capacity; surfaces `generate_cycle_brief` (#33/#35).
3. ✅ **Rich-text Note editor** — shipped (formatting + markdown + side-by-side live preview; `searchVector` preserved) (#32/#68).

### ✅ Shipped — the migration-gated set (the user approved "migrations OK")
Each added tables/columns to prod via an additive migration and has shipped:
- ✅ **Goals & OKRs** (`Objective`/`KeyResult` + routes + KR create) — fixed the 404ing page (#37/#56).
- ✅ **Personal/role Home dashboard** — shipped on a new `HomeWidget` table (#41).
- ✅ **Feature-request/bug portal** (`FeedbackItem`+`Vote`) + AI auto-bug-reporting (#38/#67).
- ✅ **Expense approval** (status/approver columns on `Expense`) (#40).
- ⏳ **Per-role workspace defaults** — still open.

Beyond this set the build-out also shipped the **work-role ABAC engine** (#42/#43/#57/#58/#59), **Partners/Products/Contracts UIs** (#61/#62/#63), **AI bots in channels + project-grouped channels** (#74/#71), and **Cmd-K quick actions** (#70).

### 📝 Design doc for sign-off — schema-heavy / cross-cutting subsystems (I will *not* build unprompted)
1. ✅ **Work-role ABAC engine** on `abacRules` — **SHIPPED** (#42/#43/#57/#58/#59): deny-only rule grammar, `requireAccess` eval, deny-policy authoring UI (see `docs/design/work-role-abac-engine.md`). The AI policy authoring/simulation piece remains planned. *The spine HR/Finance/A&E inherit.*
2. **Background-job/scheduler substrate** — durable execution, retries, idempotency, tenant isolation; activates `SavedReport.schedule`.
3. **Invoice/Quote + Payment + line-items** (+ Account→Contact→Deal CRM split) — quote-to-cash reusing the Contract PDF/DocuSign pipeline.
4. **Money correctness: Float→Decimal migration** — schema migration, **major version bump**, must precede Invoice/Payment/rev-rec.
5. **HR/People module** — `Employee` enriching `OrgMember` (manager/org-chart/department), onboarding-template execution, PTO/leave; depends on ABAC.
6. **Real vector RAG** (pgvector swap in `embed.ts`) — Postgres pgvector + embedding-model host decision (local Xenova vs hosted API + secret).
7. **AI automation/workflow rules engine** — `AutomationRule` + runner; trigger→condition(NL/AI)→action(executors) + approval routing; depends on scheduler.
8. **Cosmos-as-MCP-server** — transport (HTTP/SSE), scope→permission mapping, per-key rate limits; depends on inbound ApiKey auth.
9. **Inbound integration ingestion + Jira/Asana/Linear importer** — per-provider receivers, external-id mapping, AI field-mapping.
10. **Incident & service management** — Incident/ServiceRequest/OnCall/Escalation + SERVICE board types; depends on inbound ingestion + ABAC.
11. **Secrets vault / per-org encryption envelope** — `Integration.config`, `McpServer.env`, OAuth tokens are **plaintext today**; required before integration/MCP work multiplies stored secrets.
12. **Task dependencies + critical path** (`WorkItemDependency`) + baselines/variance.
13. **Deliverable/Milestone sign-off** + CUI/FOUO marking enforcement + DD254/flow-down.

---

## 5. Per-sector lens highlights

**PM / Delivery** — Win the daily-driver agile loop first (Cycles, Scrum/Backlog, capacity), then the governance layer (RAID, dependencies/critical-path, milestones, baselines) that locks in PMO + regulated A&E/DevOps. Moat play unavailable to point tools: capacity-vs-velocity guardrails sitting next to *actual* TimeEntry hours, and milestones that flow into Contract+DocuSign so **acceptance can trigger billing.**

**CRM / Sales / Marketing / CS** — Fix the data model (Account→Contact→Deal; today's flat `CrmContact` caps the lens at Pipedrive-lite), harvest the dormant Gmail/Calendar pipe into a persisted activity timeline (the AI data flywheel), then cadences, forecasting, quote-to-cash, health. Deepest lock-in: carrying a deal **pipeline→cash without a vendor handoff.**

**ERP / Finance / Procurement** — Procure-to-pay **and** deal-to-cash inside the same tenant that owns the contact, contract, work, and billable time. Sequencing: Float→Decimal (trust prerequisite) → Invoice+Payment → PO+Bill → Budget-vs-Actuals (nearly free on the existing `getFinanceSummary` rollup). AI wedge: the same executor architecture that does `log_revenue` can draft invoices from approved time, do 3-way PO matching, and run nightly as a standing finance-ops worker.

**A&E / GovCon / Compliance** — The unbroken thread: RFP/capture → won Contract → CDRL/deliverable sign-off → SLA tracking → the work (RAID/CCB) → ComplianceControl whose evidence is **auto-harvested** from the same platform. Land the now-tier trio (POA&M + AI evidence + deliverable sign-off) to convert the passive ComplianceControl/DataClassification/AuditLog scaffold into an irreplaceable system of record. RAID/PROGRAM/PORTFOLIO board types need *no new schema*.

**DevOps / IT / Security** — Identity gates first (SCIM inbound + SSO are dormant scaffolds and hard procurement disqualifiers). The highest-leverage architectural bet is **ABAC** (one chokepoint, inherited everywhere). Complete inbound ingestion to pull teams off incumbent trackers. Fix **plaintext secrets** before integration/MCP multiply them. Win = the cross-module graph (work-item→commit→deploy→incident→postmortem→access→compliance evidence) no point tool can assemble.

**HR / People / Training** — The `Employee` record is an enrichment of the existing `User`+`OrgMember` that already drives every module, so org chart/capacity/rates/assignments are **one graph**, not a brittle HRIS↔PM sync. Onboarding/training reuse the **same BoardTemplate/ProjectTemplate clone engine** — an "HR-defined onboarding procedure" is literally a published template that provisions real work items. AI drafts reviews from actual shipped work; ties certifications to ComplianceControl for a CMMC training-record story.

**Executive / Every-Employee / UX** — Breadth-as-a-surface: Home, the command bar, notes, preferences — the surfaces everyone touches daily regardless of role. Connect what we already own: a role-aware Home (activate `DashboardWidget`), a Cmd-K that **executes**, templates/Spaces that encode the company's own playbook. Each is impossible for a single-domain incumbent.

**AI-first / Platform / Integrations** — Be the **control plane over all org data and all actions.** We half-own three structural advantages: a cross-entity corpus (one `searchVector` + one `semanticSearch` executor over 4 entity types), a unified permission-gated executor layer (build a tool once, every AI surface gets it — internal assistant, background agents, automation engine, *and* outward MCP server), and dormant primitives (`ApiKey`, `SavedReport.schedule`, `abacRules`, outbound `Webhook` HMAC) that mean **most of this lens is activation, not greenfield.**

---

## 6. Cross-cutting sequencing constraints (read before building NEXT/LATER)

These came up independently across multiple lenses — build the shared primitive **once**:

- **Scheduler substrate** is requested by PM, CRM, ERP, DevOps, Exec, and AI lenses. Build it once; don't let each lens stand up its own runner.
- **Work-role ABAC** must land **before** HR/Finance/A&E approval features, or each reinvents per-module role checks. Sequence: ABAC → HR/Finance/A&E approvals.
- **Real vector RAG** (one pgvector swap) serves CRM search, AI memory, HR review-drafting, A&E evidence, DevOps incident-similarity. Don't build per-domain search.
- **Inbound API-key auth** (S effort) is the prerequisite for Cosmos-as-MCP-server **and** inbound webhooks. Build it first.
- **SCIM inbound** is wanted by DevOps (IAM) and HR (auto-create employees). Ship the DevOps handler now; HR's `Employee` model becomes the richer join target later — same endpoint, sequenced.
- **DocuSign/eSign + PDF** is reused by CRM (quote), ERP (invoice), A&E (CDRL/DD254), HR (offer letters). Keep one envelope-flow abstraction; each lens supplies a *template*, not a new integration.
- **Milestone** appears in both PM and A&E — **one** `Milestone` model with an optional acceptance/eSign extension, not two.
- **Money correctness (Float→Decimal)** must precede or accompany Invoice/Payment/rev-rec, or those compound float drift. Gating migration, not optional cleanup.
- **`DashboardWidget` generalization** is the shared dependency for the Exec Home, scheduled digests, and Spaces — design it to scope beyond `boardId` now so later items inherit it.

---

## 7. Integrations / MCP / Webhook proposals *(the "at the end for your review" set)*

These are **proposals, not commitments** — flagged for your decision because several are build-vs-integrate calls:

1. **Cosmos *as* an MCP server** — re-export the existing 30+ RBAC-gated executors (work-items/crm/finance/time/notes/projects/rag) as outward MCP tools over HTTP/SSE, authed by inbound `ApiKey` scopes, every call in `AuditLog`. Makes Cosmos the governed action plane external agents (Claude Desktop / Cursor / internal agents) build on.
2. **Inbound webhook receivers** for GitHub/GitLab/Azure DevOps (`commit.pushed` / `pr.merged` / `pipeline.completed`) reusing the existing SSRF guard + HMAC verify, landing linked commits/PRs on a `WorkItem` via `ticketNumber` + auto status transitions.
3. **Third-party task import/sync** for Jira/Asana/Linear/Trello/Mattermost with AI field-mapping to `WorkItemType`/`CustomField` and semantic-search de-dup — the low-switching-cost migration on-ramp.
4. **Email-to-Cosmos bridge** on the existing Gmail OAuth: inbound email AI-classified (bug/lead/note) and routed to the right board/CRM stage/note, thread-linked.
5. **GovTribe / SAM.gov MCP connector** (already listed in the env) for solicitation ingest → AI bid/no-bid + Section L/M compliance-matrix shred → `CrmContact` PROPOSAL stage → won `Contract`.
6. **Zoho Books / QuickBooks bridge** *(decision needed)* — the available Zoho Books MCP (invoices/estimates/POs/payments) could either **seed** the native Invoice module's data model **or** serve as an export target. Flag for a build-vs-integrate decision on quote-to-cash.
7. **Marketplace of installable AI-tool + automation-rule packs per sector** (DevOps incident-triage, A&E submittal-review, HR onboarding), reusing the BoardTemplate publish/clone + McpServer + IntegrationRegistry patterns. Depends on MCP-server + automation engine landing first.
8. **Webhook delivery reliability upgrade** (retry/backoff/replay/DLQ on the existing `WebhookDelivery` attempts/status columns) — a hard requirement once inbound integrations and the MCP server make customers depend on Cosmos events.

---

## 8. Appendix — dormant-infra punch list (verified in code)

| Dormant asset | Where | Unlocks |
|---|---|---|
| `COMING_SOON_TYPES`: SCRUM, BACKLOG, OKR, PORTFOLIO, RAID, ROADMAP, PROGRAM | `board-renderer.tsx` | 6 board types map directly to roadmap items |
| ✅ Cycle CRUD/capacity/`complete` API (was behind "coming soon") | `cycles/page.tsx` + cycle routes | ✅ Sprint workspace shipped (#33/#35) |
| ✅ `OkrBoard` client (was calling non-existent `/objectives`) | `okr-board.tsx` | ✅ OKR shipped (#37/#56) |
| `DashboardWidget` table — home now renders a new `HomeWidget` table | `dashboard-view.tsx` | ✅ personal Home shipped (#41); digests/Spaces still open |
| ✅ `OrgMember.abacRules` (JSON, now the ABAC rule store) | schema | ✅ Work-role ABAC shipped (#42/#58) |
| `SavedReport.schedule` (unused) | schema L1202 | Scheduler / all proactive AI |
| `ApiKey` (no inbound auth) | schema L231 | MCP-server, inbound webhooks |
| `ScimToken` (no inbound handler) | schema L1124 | SCIM provisioning |
| `OrgSecuritySettings.ssoEnforced/ssoConnectionId` | schema L1140 | SAML/OIDC SSO |
| `searchVector` token-bag (not vectors) | Note/WorkItem/Contract/SyncMeeting | Real RAG (one-file swap in `embed.ts`) |
| `process_transcript` no-op executor | `src/lib/ai/executors/` | On-write AI enrichment |
| `SyncMeeting.aiSummary`/`aiTickets` columns | schema L836 | Meeting→tickets |
| Plaintext `Integration.config` / `McpServer.env` / OAuth tokens | schema | Secrets vault (security blocker) |

---

## 9. Backlog additions (post-roadmap requests)

Items requested after the initial roadmap, tracked here alongside it.

- **AI auto-bug-reporting in the feedback portal** *(builds on the shipped feedback portal, #38).* When a user hits a technical error, the portal should either **auto-file a structured `BUG` `FeedbackItem`** (deduped against existing reports) **or** surface a one-click **"Report this problem"** that pre-fills the report with captured context — error message + stack, route/URL, user-agent, recent telemetry. Reuse the error infra already present: `WebVitalsReporter`, `/api/v1/metrics/errors`, `serverReportError` (`src/lib/telemetry/server`), and the global error listener added in `ChunkReloadGuard` (#39). AI distills the crash into a human-readable title/body and **clusters duplicates** so the portal shows "N users hit this" instead of a flood. AI-first angle: turns raw crash/analytics telemetry into triaged, deduped, human-readable, votable bug reports automatically — closing the loop from "something broke" to an actionable portal item with ~zero user effort.

---

*Generated from a multi-lens analysis grounded in the live codebase. The "build tonight" set (§4) proceeds autonomously per your standing instruction to ship clearly-scoped rounds; everything else awaits your call.*
