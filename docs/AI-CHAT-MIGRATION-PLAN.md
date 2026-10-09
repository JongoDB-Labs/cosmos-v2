# AI Chat — okr-dashboard parity migration

Driven by the survey of `/home/deploy/okr-dashboard` in 2026-05-28. Cosmos already has the core foundation (Claude CLI integration, tool-call iteration loop, audit logging, rate limiting, RBAC). This plan lists what's left to reach feature parity, plus what we intentionally diverge on.

---

## Phase 1 — Streaming + UX baseline ✅ SHIPPED

- [x] POST `/messages` route forks on `Accept: text/event-stream` — returns SSE
- [x] Chat panel reads SSE, updates a placeholder assistant message token-by-token
- [x] Tool calls surface as separate `tool_call_start` + `tool_call_result` events
- [x] Backwards-compatible: clients that omit the Accept header still get the JSON behavior

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
| Persistent `claude` CLI process pool (`src/lib/ai/cli-pool.ts`) | Forbidden, not merely unstarted: `src/lib/ai/egress/__tests__/single-path.arch.test.ts` fails the build on a `cli-pool.ts` file or any `spawn("claude"`. The loop runs native `tool_use` through the egress seam. |

---

## Effort estimates (rough)

| Phase | Effort | Risk |
|---|---|---|
| 1. Streaming + UX baseline | ✅ done | low |
| 3. Tool catalog expansion | 3-5 days | medium (each integration is its own auth flow) |
| 4. Rich UI features | 2 days | low |
| 5a. MCP support | 2 days | medium (transport variability) |
| 5b. Prompt caching + cost | 1 day (after moving to SDK) | low |
