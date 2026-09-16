# AI Chat — okr-dashboard parity migration

Driven by the survey of `/home/deploy/okr-dashboard` in 2026-05-28. Cosmos already has the core foundation (Claude CLI integration, tool-call iteration loop, audit logging, rate limiting, RBAC). This plan lists what's left to reach feature parity, plus what we intentionally diverge on.

---

## Phase 1 — Streaming + UX baseline ✅ SHIPPED (v3.5.0)

- [x] `callClaudeCliStreaming()` using `--output-format stream-json --include-partial-messages`
- [x] POST `/messages` route forks on `Accept: text/event-stream` — returns SSE
- [x] Chat panel reads SSE, updates a placeholder assistant message token-by-token
- [x] Tool calls surface as separate `tool_call_start` + `tool_call_result` events; UI strips raw `TOOL_CALL: {...}` markers from streamed text
- [x] Backwards-compatible: clients that omit the Accept header still get the JSON behavior

### Phase 1a — streaming fluidity audit (COSMOS-24, 2026-09-16)

Reported symptom: the assistant streamed "several chunks of tokens at a time" with a
delay before text appeared. The whole path was audited end to end; the defect was in
Cosmos, not on the wire.

**Root cause — the route's delta offset was not turn-aware.** `runAgentLoop`'s `onDelta`
carries the *cumulative* text of the **current turn**, and the loop restarts that buffer
at `""` on every turn. A tool-using answer therefore streams a preamble in turn N and the
real answer in turn N+1. The route tracked a single running offset across the whole run,
so once turn N+1 began, every delta shorter than the preamble was dropped and the first
one that finally exceeded it was emitted with its head sliced off. On screen: a stall
after the tool chips, then one lump of text. The fix is `src/lib/ai/stream-deltas.ts`
(`createDeltaTracker`), which detects the per-turn restart; the route now forwards
exactly one SSE `text` event per model delta.

**Connectivity / buffering audit — no change needed, recorded so it isn't re-litigated:**

| Hop | Finding |
|---|---|
| Anthropic → `egress/provider.ts` | `messages.stream()` + `.on("text")` — already one callback per `content_block_delta`. No accumulate-then-flush. |
| `agent-loop` → route | `onDelta` fires synchronously per delta; no timer, no coalescing. (The *chat bot* path in `bot-runner.ts` throttles to ~5 Hz **on purpose** — it publishes to the realtime bus, which `NOTIFY`s per event. That throttle is correct there and is deliberately not shared with the assistant panel, which owns a private SSE connection.) |
| Route → browser | One `controller.enqueue` per delta. `Cache-Control: no-cache, no-transform` (which is what makes Next's gzip layer skip the body — gzip would otherwise re-chunk it), `X-Accel-Buffering: no`, `Connection: keep-alive`. Already correct; now pinned by `messages/stream.test.ts`. |
| Caddy (`compose/Caddyfile`) | No `encode` directive, so the front door does not compress or buffer `text/event-stream`. Nothing to change. |
| Cloudflare / upstream LB | Only relevant in the deploy where TLS terminates upstream. `no-transform` + `X-Accel-Buffering: no` are the headers that opt out of proxy buffering there too, and both are already set. |
| Browser | The panel appends per event and re-renders; no throttle, no `requestAnimationFrame` batching of text. |

**Lessons taken from okr-dashboard's chat panel:** its SSE loop keeps the *server* as the
only place that decides chunk boundaries and has the client do nothing but append — no
client-side smoothing or typewriter timer, which hides real latency instead of fixing it.
We match that. Its per-conversation system prompt (identity of the requesting user) is
already ported in `assistant-prompt.ts`, and its tool-call event contract
(`tool_call_start` / `tool_call_result`) is what our SSE contract preserves. Its one
optimization we still have not taken is the persistent process/session pool (Phase 2) —
that targets time-to-*first* token, which this ticket now measures rather than guesses at.

**Measurement.** `summarizeStreamTiming` (same pure helper, both ends) reports TTFT,
delta count, chars, and mean/max inter-delta gap. Server-side it feeds
`cosmos.assistant.stream.{ttft,gap,deltas}` (counts and milliseconds only — never text);
client-side it is logged at `console.debug` on `done` alongside the server's numbers, so a
client gap materially wider than the server's points at buffering on the wire rather than
at the model. `chars / deltas` is the chunking metric: it should track the model's token
size, and a jump means something upstream started batching again.

---

## Phase 2 — Persistent CLI process pool

**Why:** spawning a fresh `claude` process per message costs ~2–3 s of cold-start. okr-dashboard keeps one process per conversation alive and pipes new messages in via `--input-format stream-json`.

- [ ] `src/lib/ai/cli-pool.ts` — Map<conversationId, PoolEntry> with idle TTL reaper (kill processes idle > 30 min)
- [ ] Switch to `--input-format stream-json --output-format stream-json` so the process accepts multiple turns
- [ ] Per-conversation message queue (drain serially so we don't interleave NDJSON)
- [ ] Process death detection → respawn on next message
- [ ] Add `chat_conversations.cli_session_id` column to persist session IDs for cross-deploy resumption

**Acceptance:** second message in a conversation arrives in < 500 ms (vs current ~3 s).

---

## Phase 3 — Tool catalog expansion (parity with okr-dashboard's 42 tools)

Cosmos currently exposes far fewer tools. Port these, gated on existing permissions:

### Google integrations (require user's OAuth tokens from existing google_tokens table)
- [ ] `send_email`, `search_emails`, `read_email`, `create_email_draft`, `manage_email_labels`, `create_email_filter`
- [ ] `list_calendar_events`, `create_calendar_event` (auto-Meet), `update_calendar_event`, `delete_calendar_event`
- [ ] `list_drive_files`, `create_drive_folder`, `delete_drive_file`, `rename_drive_file`, `move_drive_file`, `read_google_doc`, `get_drive_activity`
- [ ] `search_contacts`, `list_contacts`
- [ ] `send_meeting_link` (Meet + invite + cal event in one)

### Cosmos-internal CRUD (lean on existing API routes)
- [ ] `create_work_item`, `update_work_item`, `delete_work_item` (currently the model has to navigate via existing data)
- [ ] `create_note`, `update_note`, `delete_note`
- [ ] `add_comment`, `list_comments`, `delete_comment`
- [ ] `log_time`, `export_time_entries`
- [ ] `log_revenue`, `log_expense`, `get_finance_summary`
- [ ] `fetch_url` (server-side fetch — gated to prevent SSRF, reuse `webhookUrlSchema`)

### Diverge from okr-dashboard
- **Drop** the hardcoded card-hierarchy auto-rules ("auto-create General Epic", "Epic→Objective sync"). Cosmos is sector-agnostic — these rules are software-only and wrong for AEC/manufacturing/etc.

**Acceptance:** a survey of "the AI can do X" requests from real users hits 90 %+ without manual web/calendar checks.

---

## Phase 4 — Rich UI features

- [ ] File attachments — text (read directly), image (data URL), PDF (binary), .docx (mammoth extract). Max 5 MB.
- [ ] Voice input — Web Speech API with "send it" trigger phrase (steal directly from okr-dashboard ChatPanel.jsx:352)
- [ ] Model picker in chat header — Sonnet / Opus / Haiku
- [ ] Stop / abort button — AbortController on the fetch + SIGTERM on the server process
- [ ] Markdown rendering of assistant messages (currently raw text) — use `react-markdown` with code highlighting
- [ ] Friendly tool-call labels — "Sending email" / "Creating ticket" instead of `send_email` / `create_card`
- [ ] Status messages — "(thinking, 5 s)" / "(generating response, 12 s)" with elapsed timer

---

## Phase 5 — Cosmos-only enhancements (intentional divergence)

### MCP support
- [ ] Anthropic MCP client wired into the CLI invocation so org admins can register MCP servers per-org (stdio + http transports)
- [ ] Settings page: `/[orgSlug]/settings/mcp-servers` — list, add, remove
- [ ] Per-server enable/disable toggle; tool list visible to the model is `cosmosTools` + `mcpServers.flatMap(server => server.tools)`

### Prompt caching + cost tracking
- [ ] Tag system prompt + tool descriptions with `cache_control: { type: "ephemeral" }` when we eventually move to the Anthropic SDK (CLI doesn't expose this — flag for Phase 6)
- [ ] Capture `input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` from the stream `result` event
- [ ] New `chat_messages.usage` JSON column
- [ ] Per-conversation footer: "342 in / 1,205 out · $0.018"
- [ ] Org dashboard widget: monthly AI spend

### RAG over notes / docs / work-items
- [ ] New `embedding` column on `Note`, `WorkItem`, `Contract`, `Meeting`
- [ ] Background job: on create/update, embed text via a local model (or Anthropic embedding API if/when available) and store the vector
- [ ] pgvector extension on Postgres for similarity search
- [ ] New tool `semantic_search(query, types?)` so the model can answer "find me notes about Q4 planning" without navigating data

### Keep existing cosmos hardening
- [x] Rate limit (20 req / 40 s per user) — already shipped
- [x] RBAC permission gates (CHAT_USE) — already shipped
- [x] Audit logging — already shipped
- [x] CSRF / same-origin — already shipped at proxy layer

---

## Out of scope (explicitly NOT migrating)

| Feature in okr-dashboard | Reason to skip |
|---|---|
| Auto-create "General" epic | Software-only assumption; sector-agnostic templates handle this |
| Auto-create Objective from Epic | OKRs are one of many tracking paradigms now, not required |
| Auto-create Key Result from Story | Same reason as above |
| Hardcoded `effort_level: "high"` for CLI | Add as user preference if requested |
| `cli_session_id` *in lieu of* MCP | We're adding MCP as the longer-term standard |
| SSE done event with full content blob | Use `messageId` and let the client re-GET if it wants the canonical persisted form |

---

## Effort estimates (rough)

| Phase | Effort | Risk |
|---|---|---|
| 1. Streaming + UX baseline | ✅ done | low |
| 2. Persistent CLI pool | 1 day | medium (process death edge cases) |
| 3. Tool catalog expansion | 3-5 days | medium (each integration is its own auth flow) |
| 4. Rich UI features | 2 days | low |
| 5a. MCP support | 2 days | medium (transport variability) |
| 5b. Prompt caching + cost | 1 day (after moving to SDK) | low |
| 5c. RAG | 3-5 days | medium (embedding storage + pgvector setup) |
