# v1 → v2 carry-over: forward-looking plans & designs

This directory preserves the **forward-looking** roadmap/design/plan docs that lived in the
v1 repos (`cosmos-saas`, `cosmos-prod`) but were **not yet present in cosmos-v2** at cutover
time (2026-06-07). They are kept here verbatim, under their original `docs/` sub-paths, so no
future plan is lost in the replatform. Provenance: all 13 came from `cosmos-prod/docs`.

> These are **carried-over intent**, not statements of what v2 has already built. Each entry
> below notes the current v2 status so you know what's design-only vs partially shipped.
> When a carried plan is implemented in v2, fold it into a fresh `docs/superpowers/{specs,plans}`
> doc and delete the carry-over copy.

## Active running backlog

The live, triaged backlog is at the repo root: [`/BACKLOG.md`](../../BACKLOG.md) — refreshed
from the current v1 copy at cutover (status legend + per-item ship versions intact). It is the
single best "what's open" list; start there.

The AI-first product roadmap is at [`docs/roadmap/cosmos-ai-first-roadmap.md`](../roadmap/cosmos-ai-first-roadmap.md)
(already carried into v2 earlier).

## Carried-over designs & plans (with v2 status)

### Finance — bank feeds (design-only in v2)
- `superpowers/specs/2026-06-04-bank-feeds-design.md`
- `superpowers/specs/2026-06-05-bank-feeds-2c-inflow-match-design.md`
- `superpowers/plans/2026-06-04-bank-feeds-2a-import.md`
- `superpowers/plans/2026-06-04-bank-feeds-2b-inbox.md`
- **v2 status:** the `bank_accounts` / `bank_rules` / `bank_transactions` tables exist (added by
  the prod-parity reconciliation migration), but there is **no bank-feeds UI/logic** in `src/`.
  Forward-looking. Build on top of the v2 finance/accounting spine.

### Finance — AR invoicing (not built in v2)
- `superpowers/specs/2026-06-05-ar-invoicing-v1-design.md`
- **v2 status:** `invoices` / `invoice_line_items` / `payments` tables exist; **no invoicing UI**.
  Forward-looking.

### Finance — payroll / labor distribution (not built in v2)
- `superpowers/specs/2026-06-05-payroll-labor-distribution-design.md`
- **v2 status:** `pay_runs` table + `time_entries.pay_run_id` exist; **no payroll UI**. Forward-looking.
  (Relevant to DCAA-aware labor distribution — see the gov posture in the v2 replatform spec.)

### Classification propagation / markings (partially superseded in v2)
- `superpowers/specs/2026-06-03-classification-propagation-design.md`
- `superpowers/plans/2026-06-03-classification-phase-1-foundation.md`
- `superpowers/plans/2026-06-03-classification-phase-2-banner-chips.md`
- `superpowers/plans/2026-06-03-classification-phase-3-document-markings.md`
- `superpowers/plans/2026-06-03-classification-phase-4-chat-attachments.md`
- `superpowers/plans/2026-06-04-classification-phase-5-documents-module.md`
- **v2 status:** v2 has a CUI-blind **classifier** (`src/lib/classification/`) and the
  `DataClassification` enum in schema — but that is the *detector/egress* layer, which is a
  different concern from v1's **marking layer** (per-project banners, card chips, PDF/CSV/JSON
  markings, classified chat attachments, the Documents module). The marking-layer UI is the
  forward-looking part; reconcile it with v2's CUI-blind posture before building (don't
  reintroduce anything that weakens the egress chokepoint). The `documents` table exists; the
  Documents-module UI (phase 5) is not built.

### Chat AI bots — status notes
- `design/chat-ai-bots-status.md`
- **v2 status:** chat + bots are migrated and live (12 bots across orgs). This is a v1 status
  snapshot kept for historical context / any unfinished bot work it records.

## v2-specific deferred roadmap (from the cutover)

The prod-parity schema reconciliation (`prisma/migrations/20260607030000_prod_parity_reconciliation`)
added **18 tables** so the cutover would lose no data. Several represent **feature modules whose
data is migrated but whose v2 UI is not yet built** — these are the highest-signal "build next"
candidates because the data is already live:

| Module | Tables | v2 UI |
|---|---|---|
| Bank feeds | `bank_accounts`, `bank_rules`, `bank_transactions` | ❌ (see designs above) |
| AR invoicing | `invoices`, `invoice_line_items`, `payments` | ❌ |
| Payroll | `pay_runs` (+ `time_entries.pay_run_id`) | ❌ |
| HR / employees | `employees` | ❌ |
| Tax | `tax_rates` | ❌ |
| Documents | `documents`, `work_item_attachments` | ❌ (classification phase 5) |
| Org AI settings | `org_ai_settings` | ⚠️ verify against v2 runtime-config |
| Chat extensions | `chat_alert_keywords`, `chat_bot_runs`, `chat_bot_channels`, `chat_thread_followers` | ⚠️ partial (bots live; verify alert keywords / followers UI) |

Also deferred from the cutover tooling: the **`reconcile-globals`** helper (applies built-in
global rows — work-item types, project templates — to a fresh v2 DB). Its data effect was
applied to the live v2 DB during cutover, but the script itself was authored in a worktree that
didn't persist to the shared repo; re-author it under `scripts/cutover/` if a future fresh-DB
bring-up needs it.

## See also
- `docs/superpowers/specs/2026-06-05-cosmos-v2-replatform-design.md` — the v2 replatform design.
- `docs/superpowers/specs/2026-06-05-cui-blind-agent-architecture-design.md` — the CUI-blind posture
  that any carried-over feature must respect.
