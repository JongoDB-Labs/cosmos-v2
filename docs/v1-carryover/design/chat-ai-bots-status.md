# Chat AI Bots — phase-2 status

> **Status:** living status note · **Updated:** 2026-06-04
> Tracks what's shipped vs. scaffold-only across the in-channel AI bots. See
> `src/lib/chat/bot-runner.ts`, `src/lib/chat/ensure-bots.ts`,
> `src/lib/chat/standup.ts`, and `src/lib/chat/tool-filter.ts`.

## The bots (built-in synthetic users)

Each built-in bot is a synthetic `User` (`isBot = true`) + a `ChatBot` config row,
created idempotently by `ensureOrgBots(orgId)`. Tools always execute **as the
invoking human** (perm-scoped); the bot's `toolScope` is a hard ceiling on top.

| Bot | Key | Scope | Trigger | Status |
|---|---|---|---|---|
| Assistant | `assistant` | FULL | `@ai` / `@assistant` / `/ai` / `<@uuid>` | live (R1–R3) |
| Note-taker | `notetaker` | READONLY (+allow-list) | `@notetaker` / `/notes` | live (R1–R3) |
| Answerer | `answerer` | READONLY | auto-respond + `@answerer` | **live (R6 — this round)** |
| Standup | `standup` | READONLY | external-cron webhook | **scaffold (R6) — see D** |

## A. @answerer — auto-respond, keyword-RAG (LIVE)

- A cited-answer assistant. Runs the shared agent loop with the READONLY tool set
  (`semantic_search` + the read/query/list tools) and replies concisely **with the
  source it used**. Authored by the answerer's synthetic user.
- **Auto-respond:** when the answerer has a `ChatBotChannel` row with
  `autoRespond = true` AND `enabled = true`, a plain human message in that channel
  enqueues a detached answerer run. The decision is the pure predicate
  `shouldAnswererAutoRespond` (`src/lib/chat/autorespond.ts`), which **skips** a
  message that:
  - already @mentions a bot (no double-trigger with the mention path),
  - is authored by a bot (no bot-loop),
  - is not a plain `USER` message (no `ACTION`/`SYSTEM`/`ASSISTANT`),
  - is a thread reply or a slash command,
  - or whose poster lacks `CHAT_USE`.
- Rate-limited on the **same** `chat.ai` bucket as the mention path (an @mention
  this window already spent the budget, so auto-respond can't double AI spend);
  over budget → silent skip, never blocks the human message.
- **Zero-hit fallback:** the answerer is told to emit the sentinel
  `NO_GROUNDED_ANSWER` when it has nothing grounded. The runner posts **nothing**
  in that case — no "I don't know" spam, no SYSTEM notice.
- RAG today is the **keyword-overlap** `semantic_search` executor (NOT real
  vectors). Good enough for cited lookups; a true embedding index is future work.

## B. Tool-scope ceiling (LIVE, from R3)

`filterToolsByScope` clamps every bot to NONE / READONLY / FULL. The answerer and
standup are READONLY → they can never reach a mutation tool even if a
prompt-injected message tries to redirect them.

## C. Authorship vs. capability split (LIVE, from R3)

Reply `authorId` = the bot's synthetic user; tool execution `userId` = the invoking
human. A bot can never exceed who summoned it. Preserved by R6.

## D. @standup — SCAFFOLD ONLY (native scheduling BLOCKED)

- `buildStandupContext(channelId)` reads the channel's linked project, the last
  24h of completed work items, and the active cycle's open items → **Yesterday /
  Today / Blockers** + a one-line burndown. `formatStandup` renders the message;
  `runStandupForChannel` posts it as the standup bot and records a `ChatBotRun`.
- **Idempotency** is per `(channel, UTC day)`: `standupAlreadyRanToday` looks for
  an existing `ChatBotRun` for the standup bot, created since 00:00Z today, whose
  `message` lives in this channel. So the webhook can be hit repeatedly and posts
  at most one standup per channel per day.
- **Native in-app scheduling is BLOCKED** on the unbuilt
  [`background-scheduler-substrate.md`](./background-scheduler-substrate.md).
  There is no in-process cron yet, so the **interim trigger** is the external-cron
  webhook:

      GET /api/v1/orgs/[orgId]/chat/schedules/standup/run

  Authed by an `x-cron-secret` header (constant-time compared to
  `COSMOS_CRON_SECRET`; disabled when the env var is unset) **or** an OWNER/ADMIN
  session. It runs the standup for every channel the standup bot is enabled in
  when the bot has a `scheduleCron` set.
  - **Note on the cron field:** `scheduleCron` lives on `ChatBot` (the R3 model),
    not `ChatBotChannel`, so it's a single standup cadence applied to every enabled
    channel — chosen deliberately to avoid a new migration. The external cron owns
    the actual cadence; the webhook just runs "all due standups now".

  When the scheduler substrate ships, an internal durable job replaces the webhook
  (same `runScheduledStandups` core) and `scheduleCron` becomes the parsed cadence.

## Summary

A (answerer), B (tool-scope), C (authorship/capability split) are **live**.
D (standup) is **scaffold-only**, pending the background scheduler.
