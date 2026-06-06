# Design: Background-Job / Scheduler Substrate

> **Status:** Design proposal — needs sign-off before build · **Authored:** 2026-06-02
> **Spine item.** Requested independently by PM (scheduled briefs), CRM (cadences/health recompute), ERP (recurring billing/dunning), DevOps (SLA escalation), Exec/UX (digests), and AI-Platform (nightly agents). Build it **once** as a shared primitive — do not let each lens stand up its own runner. (See `docs/roadmap/cosmos-ai-first-roadmap.md`.)

## 1. Problem

Cosmos has **no background execution.** Everything is request/response. Consequences:

- `SavedReport.schedule` is a **dormant** field — reports can be "scheduled" in the model but nothing ever runs them.
- No way to do **proactive** AI: nightly cycle briefs, auto standup synthesis from `SyncMeeting` transcripts, deal-health recompute, SLA/option-year watchers, recurring invoices + dunning, access-review campaigns.
- This is the single thing that separates "AI-first" from "a chatbot bolt-on": the product can only *respond*, never *act on a schedule*.

## 2. Runtime constraints (this drives the design)

Per `AGENTS.md`, Cosmos is **self-hosted**, not serverless:
- Deployed as a **single long-running Next.js server** via `systemctl restart cosmos-app.service`, behind **nginx + Cloudflare Tunnel**.
- **Postgres is the system of record** (Prisma).
- There is exactly **one app process** (no autoscaling fleet today).

This rules out Vercel Cron / serverless scheduled functions. It favors a **Postgres-backed durable job queue with an in-process worker** — durable across restarts (jobs survive `systemctl restart`), no new infra, and naturally multi-tenant since it lives next to our data.

## 3. Options considered

| Option | Durable? | New infra | Fit |
|---|---|---|---|
| `setInterval` in the Next server | ❌ lost on restart, no retries, no history | none | rejected — not durable |
| systemd timer → authed internal HTTP endpoint | partial | systemd unit per job | rejected — opaque, no per-tenant queue, auth surface |
| Redis + BullMQ | ✅ | **Redis** (new) | rejected for v1 — adds a dependency we don't have |
| **Postgres-backed queue (pg-boss) + in-process worker** | ✅ | none (reuses Postgres) | **recommended** |
| Hand-rolled `Job` table + polling worker | ✅ | none | viable fallback if we want zero deps |

**Recommendation: `pg-boss`** — a mature Postgres-native job queue (durable, retries with backoff, cron scheduling, archival, dead-letter). It uses the existing Postgres, survives restarts, and needs no new service. If we want zero new deps, the hand-rolled `Job` table (§4b) is the fallback with the same shape.

## 4. Design

### 4a. Worker lifecycle
- A **singleton worker** boots with the Next server (an `instrumentation.ts` register hook or a guarded module-level init), guarded so only one instance runs.
- It registers **handlers** keyed by job type and a set of **cron schedules** (e.g. nightly digests at org-local times).
- On `systemctl restart`, in-flight jobs are re-queued (pg-boss visibility timeout); cron jobs resume.

### 4b. Job shape (hand-rolled fallback / mental model)
```prisma
model Job {
  id          String   @id @default(cuid())
  orgId       String?              // tenant scope (null = platform job)
  type        String               // "cycle.brief" | "report.run" | "invoice.recurring" | "sla.watch" | ...
  payload     Json
  runAt       DateTime             // when due
  status      String   @default("pending") // pending|running|success|failed|dead
  attempts    Int      @default(0)
  maxAttempts Int      @default(5)
  lastError   String?
  dedupeKey   String?  @unique     // idempotency (e.g. "digest:org:2026-06-02")
  createdAt   DateTime @default(now())
  @@index([status, runAt])
  @@index([orgId, type])
}
```

### 4c. Core guarantees
- **Tenant isolation:** every job carries `orgId`; handlers resolve an `AuthContext` for a **system principal scoped to that org** and call the same RBAC-gated executors — a job can never act cross-tenant.
- **Idempotency:** `dedupeKey` (e.g. `digest:{orgId}:{date}`) prevents double-sends on retry/restart. Handlers must be idempotent.
- **Retries:** exponential backoff up to `maxAttempts`, then dead-letter (visible in an admin UI) — never silent drop.
- **Observability:** job runs land in `AuditLog` (`job.<type>.completed/failed`); a Settings → Automation page shows recent runs + failures + replay.

### 4d. Activating `SavedReport.schedule`
- `SavedReport.schedule` (cron string) registers a `report.run` cron job per saved report; the handler renders the report and delivers it (in-app notification + optional email via the existing Gmail OAuth).

## 5. What it unlocks (the payoff, across lenses)

- **PM:** nightly `generate_cycle_brief` for active cycles; weekly portfolio digest.
- **AI-Platform:** auto standup synthesis from new `SyncMeeting` transcripts; the **automation rules engine** (separate doc) runs its time-triggered rules on this substrate.
- **CRM:** deal-health recompute; cadence step sends with auto-pause-on-reply.
- **ERP:** recurring invoice generation; dunning reminders; AR-aging snapshots.
- **DevOps/A&E:** SLA / contract-option-year watchers; access-review campaigns; compliance evidence refresh.
- **Exec/UX:** scheduled "your morning briefing" digests.

## 6. AI-first angle

Jobs whose handler is an **AI executor call** turn Cosmos from a system-of-record into a **system-of-action**: a nightly job asks Claude (via the existing CLI bridge + tool executors) to summarize, flag, and *act* — draft the invoice, open the risk item, ping the owner. This is the substrate the automation rules engine and all "proactive AI" features depend on.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Multiple workers double-run jobs | Singleton guard; pg-boss row-locking / `FOR UPDATE SKIP LOCKED` ensures one consumer per job. |
| A job storm starves request handling | Bounded worker concurrency; jobs run in the same process but capped; consider a separate worker process later if needed. |
| AI jobs are slow/expensive | Per-org rate limits + budget caps on AI jobs; backoff; dead-letter on repeated failure. |
| Restart loses in-flight work | Durable queue (Postgres) — jobs re-queue on restart; idempotent handlers make replay safe. |
| Timezone correctness for digests | Schedule in org/user local time using existing `UserPreferences.dndTimezone` / org timezone. |

## 8. Rollout / sequencing

1. Add the queue (pg-boss) + worker bootstrap + `Job`/archival tables + the admin Automation page (runs/failures/replay). **No user-facing behavior yet.**
2. First handler: `cycle.brief` (reuses the existing `generate_cycle_brief` executor) — proves the path end-to-end.
3. Wire `SavedReport.schedule` → `report.run`.
4. Then the **automation rules engine** and per-lens proactive jobs build on it.

**Open questions for sign-off:** (a) `pg-boss` dependency vs hand-rolled `Job` table; (b) in-process worker vs a separate `cosmos-worker.service` systemd unit (cleaner isolation, slightly more ops); (c) per-org AI-job budget/rate-limit policy.
