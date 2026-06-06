# AI Chat — End-to-end Validation Plan (Phases 1-5)

**Target version:** v3.5.0
**Spec:** `docs/AI-CHAT-MIGRATION-PLAN.md`
**Scope:** every feature added in Phases 1, 2, 3a, 3b, 4, 5a, 5c.

This document is structured so a Claude Code session can execute it sequentially. Each row: action → expected behavior → verification step. Mark ✅ / ❌ / ⏭.

---

## Pre-flight

- [ ] App reports v3.5.0 at `GET /api/health`
- [ ] Sign in as OWNER (you have all permissions including MCP_MANAGE)
- [ ] Open Chat: `/[orgSlug]/chat`
- [ ] Open browser DevTools → Network tab → filter on `messages` and `mcp-servers`

---

## Phase 1 — Token streaming (the original ask)

| # | Action | Expected |
|---|--------|----------|
| 1.1 | Click "New Conversation" | New conversation created, empty chat |
| 1.2 | Type "Tell me a 50-word joke about databases" → Send | Assistant bubble appears **immediately**. Tokens stream in word-by-word, not all at once after a delay. |
| 1.3 | Watch Network tab during 1.2 | Single fetch to `POST /api/v1/orgs/:org/chat/conversations/:id/messages` with `Accept: text/event-stream`. Response stays open ~5-15s with `Content-Type: text/event-stream`. |
| 1.4 | View the response payload | Lines of `data: {...}\n\n` — events of type `text`, `tool_call_start`, `tool_call_result`, `done` |
| 1.5 | After done, the message persists | Reload page → message still there with full content + tool calls |

**Verify TOOL_CALL markers are NOT visible:** if the model produces a tool call, you should see a tool chip in the bubble, NOT raw `TOOL_CALL: {...}` text.

---

## Phase 2 — Persistent CLI pool

| # | Action | Expected |
|---|--------|----------|
| 2.1 | Send first message in a fresh conversation. Time how long until first token appears | Cold start: 2-5s |
| 2.2 | Send a second message immediately after | Warm: **first token < 800ms**. This proves the process was reused. |
| 2.3 | Check DB: `SELECT cli_session_id FROM chat_conversations WHERE id = '<convo>';` | Non-null UUID, persists across messages |
| 2.4 | Send a third message | Same fast latency. cli_session_id unchanged. |
| 2.5 | Wait 31 minutes → send another message | Cold start again (process was reaped); cli_session_id may rotate but session resumes |
| 2.6 | Force a process death: `pkill -f "claude -p"` on the server, then send a message | Next send: pool detects death, respawns, message completes successfully (verify in server logs) |
| 2.7 | Trigger fallback: pass an invalid model and verify the SSE `debug` event fires | Server logs show "fallback" debug event; chat still works via legacy one-shot |

---

## Phase 3a — Google integration tools (Gmail / Calendar / Drive / Contacts)

**Pre-req:** your Google account must be connected. Sign out + back in if `gmail.send` scope was missing.

| # | Prompt | Expected tool called | Verify |
|---|--------|---------------------|--------|
| 3a.1 | "Search my emails for anything about Q4 planning, last 30 days" | `search_emails` | Returns list with id/subject/from. Tool chip shows "Searching emails" |
| 3a.2 | "Read the most recent email from my boss" (assuming a known sender) | `search_emails` → `read_email` | Two tool calls; body returned |
| 3a.3 | "Draft an email to test@example.com saying 'Hello, just a test'" | `send_email` or `create_email_draft` | Email arrives (if send) OR draft appears in Gmail Drafts (if draft) |
| 3a.4 | "What's on my calendar for this week?" | `list_calendar_events` | Returns events. Tool chip: "Listing calendar events" |
| 3a.5 | "Create a calendar event tomorrow at 3pm called 'Test Meeting' for 30 min, invite me@example.com" | `create_calendar_event` | Event appears in Google Calendar with a Google Meet link |
| 3a.6 | "List the 10 most recent files in my Drive" | `list_drive_files` | File metadata returned |
| 3a.7 | "Read this Google Doc and summarize it: <docId>" | `read_google_doc` | Doc text fetched and summarized |
| 3a.8 | "Find Alice's contact info" (or any known contact) | `search_contacts` | Email returned |

**Failure modes:**
- If Google account NOT connected: tool returns `{error: "User has not connected their Google account..."}` — the assistant should report this gracefully.
- If a scope is missing (e.g., requesting calendar.write but only have calendar.readonly): error includes the missing scope.

---

## Phase 3b — Cosmos-internal CRUD tools

### Work items
| # | Prompt | Expected | Verify |
|---|--------|----------|--------|
| 3b.1 | "Create a task in project SCRATC called 'Test from AI'" | `create_work_item` | New row in the project's board with title "Test from AI" |
| 3b.2 | "List all work items in SCRATC" | `list_work_items` | Returns array |
| 3b.3 | "Update work item #5 to mark it done" | `update_work_item` (with columnKey: "done") | Card moves to Done column |
| 3b.4 | "Delete work item #5" | `delete_work_item` | Row gone from board |

### Notes
| # | Prompt | Expected | Verify |
|---|--------|----------|--------|
| 3b.5 | "Create an org-wide note titled 'AI Test' with body 'Hello from AI'" | `create_note` | Appears in /notes |
| 3b.6 | "Update that note to add ' Updated' to the title" | `update_note` | Title changes |
| 3b.7 | "Delete that note" | `delete_note` | Note disappears |

### Comments
| # | Prompt | Expected | Verify |
|---|--------|----------|--------|
| 3b.8 | "Add a comment to work item #5 saying 'Looks good'" | `add_comment` | Comment appears in the work-item detail dialog |
| 3b.9 | "List comments on work item #5" | `list_comments` | Returns array |

### Time
| # | Prompt | Expected | Verify |
|---|--------|----------|--------|
| 3b.10 | "Log 2 hours of billable time today for project SCRATC, description 'AI testing'" | `log_time` | Row in /time-tracking |
| 3b.11 | "Show me my time entries this week" | `list_time_entries` | Returns array |

### Finance
| # | Prompt | Expected | Verify |
|---|--------|----------|--------|
| 3b.12 | "Log $500 of revenue today from client TestCorp, one-time" | `log_revenue` | Row in /finance |
| 3b.13 | "Log a $50 SaaS expense today for vendor 'GitHub'" | `log_expense` | Row in /finance expenses |
| 3b.14 | "What's my finance summary for this month?" | `get_finance_summary` | Total revenue / expenses / net returned |

### Projects / cycles
| # | Prompt | Expected | Verify |
|---|--------|----------|--------|
| 3b.15 | "List my projects" | `list_projects` | Array returned |
| 3b.16 | "List cycles for SCRATC" | `list_cycles` | Array (possibly empty) |
| 3b.17 | "Create a 2-week cycle for SCRATC called 'Sprint 1' starting today" | `create_cycle` | Cycle exists in DB; `SELECT * FROM cycles WHERE project_id=...` |

### Utility
| # | Prompt | Expected | Verify |
|---|--------|----------|--------|
| 3b.18 | "Fetch https://example.com and tell me what's there" | `fetch_url` | Returns "Example Domain..." |
| 3b.19 | "Fetch http://localhost:3000 and tell me what's there" | `fetch_url` rejects | Returns SSRF error (validates `webhookUrlSchema`) |
| 3b.20 | "Fetch http://10.0.0.1 and tell me what's there" | `fetch_url` rejects | Returns SSRF error |

### Permission gating (do this as a MEMBER user, not OWNER)
| # | Prompt | Expected |
|---|--------|----------|
| 3b.21 | "Delete work item #1" as MEMBER | Returns `{error: "Insufficient permissions"}` (MEMBER lacks ITEM_DELETE) |
| 3b.22 | "Log $100 revenue" as MEMBER | Returns permission error (MEMBER lacks FINANCE_MANAGE) |
| 3b.23 | "List projects" as MEMBER | Works (PROJECT_READ is in MEMBER role) |

---

## Phase 4 — Rich UI

### Markdown rendering
| # | Action | Expected |
|---|--------|----------|
| 4.1 | "Reply with a markdown bulleted list of 3 fruits" | List renders as actual bullets, not asterisks |
| 4.2 | "Show me a code block with the word 'hello' in JavaScript" | Code block rendered with monospace + background |
| 4.3 | "Reply with a markdown table of 3 colors and their hex codes" | Table renders with borders |
| 4.4 | Verify user messages are NOT markdown-rendered | User bubbles show raw asterisks/hashes if you type them |

### Stop / abort
| # | Action | Expected |
|---|--------|----------|
| 4.5 | "Write a 500-word essay on Mars" → Send | Send button becomes Stop (Square icon) while streaming |
| 4.6 | Click Stop mid-stream | Stream aborts. Accumulated text is preserved (visible in the bubble). Send button returns. |
| 4.7 | Network tab shows the fetch was canceled | Status: `(canceled)` |

### Model picker
| # | Action | Expected |
|---|--------|----------|
| 4.8 | Open chat → click model dropdown in header | Three options: Sonnet, Opus, Haiku |
| 4.9 | Pick Haiku → reload page | Selection persists (localStorage `cosmos.chatModel`) |
| 4.10 | Send a message → inspect POST body | `{content, model: "haiku"}` |
| 4.11 | Server logs / behavior should reflect haiku (faster + cheaper) | Subjective: response feels faster |

### Friendly tool labels
| # | Action | Expected |
|---|--------|----------|
| 4.12 | "Create a project called X" | Tool chip shows "Creating project…" with spinner, then "Created project" |
| 4.13 | "Search my emails" | Chip "Searching emails" → "Searched emails" |
| 4.14 | Unknown tool name | Falls back to "Running ${name}" |

### Status with elapsed timer
| # | Action | Expected |
|---|--------|----------|
| 4.15 | Send message → before first token | Bubble shows "Thinking… (1s)" → "(2s)" → "(3s)" ticking |
| 4.16 | First token arrives | Status disappears, text appears |
| 4.17 | During tool execution | Status shows "Creating project… (Ns)" |

### File attachments (text only)
| # | Action | Expected |
|---|--------|----------|
| 4.18 | Click paperclip → pick a .txt file | Chip appears above textarea with filename + size + X |
| 4.19 | Pick a 6MB file | Error: "Files exceed 5MB total cap" |
| 4.20 | Pick a .jpeg file | Rejected (not in text-ish list) |
| 4.21 | Send message with attached .json file | Model receives `[File: name.json]\n<content>` prepended; can answer questions about it |
| 4.22 | Click X on a chip | File removed |

---

## Phase 5a — MCP server support

### Settings page exists
| # | Action | Expected |
|---|--------|----------|
| 5a.1 | Navigate to `/[orgSlug]/settings/mcp-servers` | Page loads. Empty state: "No MCP servers configured" |
| 5a.2 | As MEMBER user, navigate to same URL | Redirects to /settings (lacks MCP_MANAGE) |
| 5a.3 | Click "Add Server" | Dialog opens with: Name, Transport (stdio/http/sse), conditional fields |

### Add stdio server
| # | Action | Expected |
|---|--------|----------|
| 5a.4 | Pick Transport: stdio | Form shows: command, args (multi-line), env (KEY=VALUE list) |
| 5a.5 | Fill in: name="Test Echo", command="cat", args=[], env={} → Save | POST /mcp-servers 201; row appears in table |
| 5a.6 | Toggle row's enabled switch off | PATCH 200; row dims |
| 5a.7 | Edit the row → change name → Save | PATCH 200; new name visible |
| 5a.8 | Delete the row | Confirm dialog → DELETE 200; row gone |

### Add http server
| # | Action | Expected |
|---|--------|----------|
| 5a.9 | Pick Transport: http, fill: name="Test HTTP", url="https://mcp.example.com" → Save | POST 201 |
| 5a.10 | Edit → add headers `{"Authorization": "Bearer xxx"}` → Save | PATCH 200 with new headers JSON |

### Validation
| # | Action | Expected |
|---|--------|----------|
| 5a.11 | Try to save stdio server with no command | Inline error |
| 5a.12 | Try to save http server with no url | Inline error |

### CLI integration
| # | Action | Expected |
|---|--------|----------|
| 5a.13 | Add an enabled MCP server, send a chat message | Server logs show `--mcp-config /tmp/cosmos-mcp-*/mcp.json` arg passed to claude. The MCP server's tools are available to the model (test by asking "what tools do you have?") |
| 5a.14 | Disable all MCP servers, send a message | No `--mcp-config` arg; only built-in cosmos tools available |
| 5a.15 | Check that temp file is cleaned up | After message completes, `/tmp/cosmos-mcp-*/` directory removed (or cleaned on pool eviction) |

---

## Phase 5c — RAG / semantic search

### Note: pgvector NOT installed → falls back to JSON token-overlap pseudo-embeddings (`TODO(rag)` markers in `src/lib/rag/embed.ts`)

### Setup
- [ ] Run the backfill: `DATABASE_URL=... npx tsx scripts/backfill-embeddings.ts`
- [ ] Confirm output: "Processed N notes, M work items, ..."

### Embed-on-write
| # | Action | Expected |
|---|--------|----------|
| 5c.1 | Create a note titled "Q4 planning kickoff" with body "Goals and timeline for next quarter" | After POST, `SELECT search_vector FROM notes WHERE title='...'` returns a non-null JSON object |
| 5c.2 | Create a work item titled "Migrate Stripe webhooks" | After POST, `SELECT search_vector FROM work_items WHERE title='...'` returns non-null |
| 5c.3 | Update the note's title to "Q4 strategy" | `search_vector` re-computes on update |

### semantic_search tool
| # | Prompt | Expected | Verify |
|---|--------|----------|--------|
| 5c.4 | "Search semantically for notes about Q4 planning" | `semantic_search` called with query, returns the Q4 note as top result | Tool chip "Running semantic_search" |
| 5c.5 | "Find anything in our workspace about Stripe" | Returns the work item from 5c.2 | |
| 5c.6 | Permission: as VIEWER, run a semantic search | Returns only items the user can see (public notes, work items in projects they're members of) |
| 5c.7 | "Find notes about XYZ_NONEXISTENT" | Returns empty array (no false positives) |

### Direct API smoke (advanced)
- [ ] `curl -X POST /api/v1/orgs/:org/chat/.../messages -H "Accept: text/event-stream" ...` with prompt that triggers `semantic_search` — verify the tool_call_result event includes `{type, id, title, snippet, similarity, url}`

---

## Cross-cutting checks

### Audit logs
- [ ] `/settings/audit-logs` shows `chat.message.sent` with `pool: "persistent"` or `"one-shot"` in metadata
- [ ] MCP CRUD logged: `mcp_server.created`, `mcp_server.updated`, `mcp_server.deleted`

### Rate limit
- [ ] Send 25 messages in 40 seconds → 21st should return 429 (existing limit: 20 req / 40s per user)

### Permission gating
- [ ] As VIEWER (CHAT_USE not in role), POST /messages returns 403

### Stream resilience
- [ ] Send a long message → mid-stream, the connection survives a brief network blip (re-test with throttling in DevTools)
- [ ] Server logs don't show unhandled exceptions during normal usage

### Security
- [ ] `fetch_url` rejects file://, localhost, 127.0.0.1, 10.0.0.0/8, 169.254.169.254 (AWS metadata)
- [ ] MCP temp files are mode 0o600 (only owner readable)
- [ ] Embeddings don't leak PII to other orgs (cross-org isolation verified by 5c.6)

---

## Test artifact cleanup

After the validation pass, remove:
- Test work items, notes, comments, time entries, revenue/expense rows
- Test MCP server entries
- Test conversations and messages
- Test calendar events / drafts (your Gmail will have remnants)

---

## Scorecard template

```
Phase                              Pass / Total
─────────────────────────────────────────────────
1. Streaming                         _/5
2. Persistent CLI pool               _/7
3a. Google tools                     _/8
3b. Internal tools                   _/23 (including 3 permission tests)
4. Rich UI                           _/22
5a. MCP                              _/15
5c. RAG                              _/7
─────────────────────────────────────────────────
Total                                _/87
```

---

## Known limitations (intentional, not bugs)

1. **RAG uses keyword-overlap, not real embeddings** — `TODO(rag)` markers in code. To upgrade: install pgvector + `@xenova/transformers`, or switch to a hosted embedding API.
2. **Phase 5b (prompt caching + cost tracking) NOT shipped** — the Claude CLI doesn't expose per-message token counts cleanly. Deferred until we move from CLI to direct Anthropic SDK.
3. **Voice input deferred to Phase 4b** — Web Speech API + "send it" trigger.
4. **Binary file attachments deferred to Phase 4b** — images, PDFs, .docx need a content-type-aware pipeline.
5. **No model auto-fallback** — if Sonnet is rate-limited, the request fails. Add retry-with-Haiku in a follow-up.
6. **Embed-on-write is synchronous** — adds ~50ms to note/work-item create. Move to background queue once we have one.
7. **MCP hot-reload not supported** — if you change MCP servers while a conversation has an active CLI process, you must close + reopen the conversation. The CLI doesn't support live config swaps.
