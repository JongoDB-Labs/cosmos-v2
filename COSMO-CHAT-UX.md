# Cosmo chat assistant — UX improvements

Three UX fixes on top of `origin/main` (v2.200.0). Investigation, root cause, and
approach for each, plus the okr-dashboard pattern mirrored for Change 3.

Shared context:
- Chat send flow: `src/app/api/v1/orgs/[orgId]/assistant/conversations/[conversationId]/messages/route.ts`
  (POST → `runAgentLoop` → SSE stream of `text` / `tool_call_start` / `tool_call_result` / `done`).
- The ONE egress chokepoint: `runModelTurn` in `src/lib/ai/egress/index.ts` (the only
  sanctioned model call; enforced by ESLint + `egress/__tests__/single-path.arch.test.ts`).
- Chat UI: `src/components/assistant/assistant-panel.tsx` (sidebar list, SSE parser,
  `MessageBubble`).
- The agent loop returns `AgentToolCall[]` = `{ id, name, arguments, result }` and persists it
  to `AssistantMessage.toolCalls` (`prisma/schema.prisma:1966`). No `status` field.

---

## Change 1 — Auto-title conversations (Anthropic Claude Chat UX)

**Root cause.** Two title paths, neither descriptive:
- The "New conversation" button and the empty-state send both stored the literal default
  `"New conversation"` (`assistant-panel.tsx` createConversation; conversations `route.ts:57`
  defaults it), and nothing ever replaced it → stuck forever.
- The type-and-send path pre-set the title to the raw first message truncated to 60 chars
  (`assistant-panel.tsx` old line ~580) — crude, and it *blocked* any later real titling because
  the title was no longer the default sentinel.

**Approach.** Generate a concise title once, after the first exchange, through the SAME egress
chokepoint, and stream it back.
- New pure/generator module `src/lib/ai/conversation-title.ts`:
  - `cleanTitle()` — pure: first line, strips wrapping quotes / `Title:` label / trailing
    punctuation, collapses whitespace, caps at 60. Returns `""` when nothing usable.
  - `generateConversationTitle()` — calls `runModelTurn` (same chokepoint, same connected
    credential resolved inside it) with a short system prompt, the first exchange only, `tools: []`,
    `maxTokens: 24`. Returns `""` on any error so titling never breaks the message flow.
- Route (`messages/route.ts`): `maybeGenerateTitle()` fires ONLY while the stored title is still
  `DEFAULT_CONVERSATION_TITLE` (so it runs exactly once — later turns short-circuit), persists the
  title on the conversation, and — in the streaming path — emits it as a new `title` SSE event
  AFTER `done` (message renders immediately; title lands a beat later). Blocking path persists it too.
- Client (`assistant-panel.tsx`): the type-and-send path now creates with the default title (server
  governs titling — one mechanism); a `title` SSE event updates the conversation in state → the
  sidebar row and header swap "New conversation" for the generated title.

CUI note: the transcript is gated by the chokepoint like any other model input (a controlled
marking ⇒ withheld body), so titling is CUI-blind.

Files: `src/lib/ai/conversation-title.ts` (+ `.test.ts`); `messages/route.ts`; `assistant-panel.tsx`.

---

## Change 2 — Tool-call chips stuck on "loading"

**Root cause (two spots, `assistant-panel.tsx`).**
1. The `done` SSE handler overwrote the client's live chips —
   `toolCalls: evt.toolCalls ?? liveToolCalls` — with the server's `result.toolCalls`
   (`AgentToolCall[]`, **no `status`**). `MessageBubble` rendered "done" as `tc.status === "done"`,
   so every status-less chip reverted to the spinner immediately after `done` and stayed there.
2. Same shape on reload: persisted `AssistantMessage.toolCalls` also carry no `status`, so every
   reopened conversation replayed all chips spinning forever.

**Approach.** Make the status a default-closed state machine and finalize on every terminal edge.
- New pure module `src/lib/assistant/tool-status.ts`:
  - `isToolCallRunning(tc)` → `tc.status === "running"` (a `"done"` OR *absent* status ⇒ not running).
  - `finalizeToolCalls(tcs)` → stamps every call `status: "done"` (new array, no mutation).
- Client: `done` handler wraps its tool calls in `finalizeToolCalls(...)`; the SSE loop's `finally`
  finalizes any still-running chips on the pending bubble (covers stream close / drop / abort — the
  requested stream-close case); `MessageBubble` now keys off `isToolCallRunning(tc)` so persisted
  (status-less) chips render as done.

Files: `src/lib/assistant/tool-status.ts` (+ `.test.ts`); `assistant-panel.tsx`.

---

## Change 3 — Linked entity artifacts in chat

**okr-dashboard (v1) pattern.** `client/src/components/ChatPanel.jsx`:
- `ToolCallBadge` (line 101) mapped mutating tool calls to entity-referencing labels from the tool
  args: `create_card` → `"Created: {args.title}"`, `update_card` → `"Updated card {args.id}"`,
  `delete_card` → `"Deleted card {args.id}"`. A static colored `<div>` — **not** clickable.
- On each tool result the panel called `onCardAction?.()` (`ChatPanel` line 248-251) →
  `onCardAction={loadAll}` (`App.jsx:1223`) to refresh the board. The app's separate deep-link
  mechanism was `onOpenCard(cardId)` → `setNavigateTo({ type:"card", id })` (`App.jsx:1241`), but the
  badge itself was never wired to it.

**How I mirrored + upgraded it.** Keep the "mutating tool → entity-referencing label" idea, but
because cosmos-v2 is route-based (not one board) I turned the static badge into a real **clickable
card that deep-links to the entity**, reusing the shared `entityUrl` builder so a chat link is
identical to an @-mention link.
- New pure module `src/lib/assistant/artifacts.ts`: `toolCallToArtifact(tc, { orgSlug })` /
  `artifactsFromToolCalls(...)`.
  - Only `create_`/`update_`/`delete_` tools that map to a navigable mentions `EntityType`
    (`TOOL_ARTIFACT_TYPE`) produce a card — reads and non-navigable entities are skipped.
  - Entity id from `result.id` (present on every mutating executor success — verified against
    `executors/*.ts`), falling back to the id the user passed on updates; a `{ error }` result →
    no card.
  - URL via `entityUrl(type, { orgSlug, projectKey, id })` (`src/lib/mentions/urls.ts`). Work
    items / notes / meetings / crm / partners / products link by **id alone**; `create_project`
    links via the `key` in its args. Deletes and project-scoped types with no available project
    key render as a non-linking card (graceful degradation, same contract the @-mention chips use).
  - Label is the entity's own title/name/ticket from the result/args.
- Client: `MessageBubble` derives `artifactsFromToolCalls(message.toolCalls, { orgSlug })` from the
  SAME tool calls (so cards show for both a live stream and a reopened conversation) and renders an
  `ArtifactCard` (Next `<Link>` when linkable, else a static card).

**CUI-blind masking.** The card is built from the tool call's USER-facing `result` (the executor's
full output — the same data the existing "Tool result" panel already shows and that RBAC authorized
when the tool ran as the user). It **links by id**; the entity's own detail page enforces
authorization + classification on click. The model never saw the withheld fields — this surface only
shows the invoking user what they were already entitled to see.

Files: `src/lib/assistant/artifacts.ts` (+ `.test.ts`); `assistant-panel.tsx` (`ArtifactCard`).

---

## Tests & checks

- New unit tests (pure logic), all passing:
  - `src/lib/assistant/tool-status.test.ts` — running/done detection, finalize, no-mutation.
  - `src/lib/assistant/artifacts.test.ts` — work-item/project/note/objective/delete/error/read cases,
    id fallback, label composition.
  - `src/lib/ai/conversation-title.test.ts` — `cleanTitle` cases + `generateConversationTitle`
    routes through the mocked chokepoint (no tools, low tokens) and swallows failures.
- `egress/__tests__/single-path.arch.test.ts` still passes (the new `runModelTurn` caller respects
  the single egress path). Full egress + assistant-prompt suites: 93 passing.
- `tsc --noEmit`: no errors in any changed/added file. (13 pre-existing errors remain in
  foreman/plan files, all from a stale symlinked prisma client that lacks `ForemanAiSettings` —
  the model exists in `prisma/schema.prisma`; unrelated to this work.)
- `eslint` on all changed files: clean.
