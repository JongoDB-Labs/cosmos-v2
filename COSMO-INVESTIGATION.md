# Cosmo chat assistant — bug investigation & fixes

Branch: `cosmo-identity-context-fix` (worktree `/home/ubuntu/cosmos-cosmo-fix`, off `origin/main`).
Trigger: OWNER asked Cosmo "assign a test story ticket to me in vitl bma project" and hit three failures.

Cosmo's server-side loop: the assistant route builds a system prompt + serialized
transcript and calls `runAgentLoop` (`src/lib/ai/agent-loop.ts`), which runs a native
`tool_use` loop through the single egress chokepoint (`runModelTurn`) and executes each
tool via `executeTool(name, input, { orgId, userId, tenantClass, conversationId })`. Every
tool RESULT is projected through the CUI-blind egress gate before it re-enters the model
context.

---

## Root causes (file:line evidence)

### #1 Identity — the model was never told who it is talking to
- The assistant route built Cosmo's system prompt from a **static constant with no user
  identity** (old `BASE_SYSTEM_PROMPT`, formerly `messages/route.ts:34-48`) and set
  `initialPrompt` to just the serialized transcript (`messages/route.ts:164`, tags
  `User:`/`Assistant:` — no name/email/id).
- The loop threads `userId` into `executeTool` for permission-scoping
  (`agent-loop.ts:266-273`) and the credential resolver reads it (`egress/index.ts:132`),
  but **that id is never surfaced into the model's context**. So Cosmo genuinely did not
  know the requesting user and asked "who are you / what's your user ID?".
- Compounding it: there is no "current user" default anywhere for assign-to-me. Assignee
  params are strict uuids (`executors/work-items.ts:24,35`) with no self/"me" resolution,
  and `list_org_members` names/emails are withheld by the gate (see #3), so the model had
  no path to map "me" → a userId even if it tried.
- The in-channel chat bots already inject the invoker's display name into their initial
  prompt (`src/lib/chat/bot-runner.ts:196`) — the assistant route simply never did.

### #2 Fuzzy project resolution — no server-side resolver, and names are hidden
- `list_projects` had **no query/filter param** — it returned every project
  (`executors/projects.ts:26-57`; tool def `tools/projects.ts:5-14`). No fuzzy match on
  name or key, so "VITL BMA" could not be turned into the VITL project.
- `semantic_search` **does not cover projects** — its type enum is
  `note | work_item | contract | meeting` only (`executors/rag.ts:9-11`).
- And because the org is treated as `gov` (see #3), the gate withholds project `name`/`key`
  from the model (`egress/projection.ts:56` — `project` exposes only
  `["id","archived","createdAt","updatedAt"]`), so the model could not even match names
  client-side. Net: no server-side resolver + no visible names = resolution impossible.

### #3 "Encrypted/obfuscated" titles + member details — the DELIBERATE CUI-blind gate
- This is **intentional, not a bug in the masking**. The egress gate is data-classification
  driven and **fail-closed**: for `tool_result` data it WITHHOLDS when the ceiling ≥ FOUO
  (both tenants) OR the tenant class is `gov` (`egress/gate.ts:34-36`). Withheld results are
  replaced by a structural, default-deny projection: ids/enums/dates only — all free-text
  content, names, emails, money dropped (`egress/projection.ts:30-174`). Examples:
  `project → id/archived/timestamps` (56), `org_member → userId/role` only, names/emails
  dropped (65), `work_item` keeps ids/status but not `title` (35-39), `search_result`
  exposes `id/type/similarity`, titles/snippets become opaque handles (71, 224-225).
- **Why Jon's org hit it:** `Organization.tenantClass` **defaults to `GOV`**
  (`prisma/schema.prisma:180`), and the route fail-closes anything not explicitly
  `COMMERCIAL` to `gov` (`messages/route.ts:177-178`). So unless an admin flipped the org to
  COMMERCIAL, Cosmo runs fully CUI-blind — every title/name is withheld. Cosmo then
  mis-described the withheld placeholders to the user as "encrypted/obfuscated" and burned
  its 5-iteration budget (`agent-loop.ts:52`) trying to identify things by content it is
  not allowed to read.
- Cosmo is *designed* to operate on masked data by **id** (and by opaque handles the loop
  mints for withheld CUI string fields, `agent-loop.ts:296-313`). Nothing taught the model
  that, so it floundered.

---

## What I implemented + tested (TDD, all localized, CUI boundary preserved)

New module `src/lib/ai/assistant-prompt.ts` (base prompt extracted from the route + made
testable) holds `BASE_SYSTEM_PROMPT` and `buildAssistantSystemPrompt(identity)`.

1. **Identity injection (#1).** `messages/route.ts` now loads the requesting user's
   `displayName`/`email` and org role and builds the system prompt via
   `buildAssistantSystemPrompt({ userId, name, email, role })`, threaded through
   `IterationCtx` to both the blocking and streaming loop calls. The injected block names
   the user, states their user id, and instructs the model to never ask who they are and to
   treat "me/my/assign to me" as that user id.
   - Safe w.r.t. the gate: system-prompt text is exposed to the model (`gate.ts:33`,
     `valueKind:"system"`); it is the requester's OWN identity, never other members' PII.
   - Tests: `src/lib/ai/assistant-prompt.test.ts` (6).

2. **Self-assign sentinel (#1).** `executors/work-items.ts` resolves an `assigneeId` of
   `me`/`@me`/`self`/`myself`/`current user` (case/space-insensitive) to `ctx.userId` before
   validation, in `createWorkItem` and `updateWorkItem`. Real uuids and "no assignee" pass
   through unchanged. Backstops the prompt so "assign to me" works even if the model doesn't
   echo the uuid. Runs in the executor (after the loop's handle-resolve/taint checks); "me"
   is not a handle and userId is not CUI, so the egress boundary is untouched.
   - Tests: added to `src/lib/ai/executors/work-items.test.ts` (4).

3. **Fuzzy project resolution (#2).** `list_projects` gains an optional `query` that
   fuzzy-matches project **name + key server-side** (tokenized, case-insensitive; "VITL BMA"
   → VITL) and returns only the matches, best first (`executors/projects.ts`
   `scoreProjectMatch` + filter; tool def updated in `tools/projects.ts`). The match runs on
   real values server-side; the model still only receives the resolved **id** (names stay
   withheld downstream for gov) — so this **does not weaken the CUI boundary**. No query ⇒
   unchanged behavior.
   - Tests: added to `src/lib/ai/executors/projects.test.ts` (1, multi-assertion).

4. **CUI-blind operating guidance (#3, safe half).** `BASE_SYSTEM_PROMPT` now teaches the
   model that withheld content is a **privacy/classification boundary, not corruption** —
   it must never call data "encrypted/corrupted/obfuscated", must operate by id/handle, and
   must resolve names server-side (`list_projects` query, `semantic_search`) instead of
   asking the user or giving up. Pure prompt text; no masking change.
   - Tests: `assistant-prompt.test.ts` (2).

Verification: `src/lib/ai` suite **306/306 pass** (incl. new tests); `eslint` clean on all
changed files; `tsc --noEmit` clean.

---

## What needs a HUMAN DECISION (do NOT change unilaterally)

**Is the org actually a GOV tenant, or mis-defaulted to GOV?** This is the crux of #3.
`Organization.tenantClass` defaults to `GOV` (`schema.prisma:180`), so a commercial customer
that was never explicitly marked `COMMERCIAL` runs fully CUI-blind.

- **If the org is genuinely commercial** (a normal SaaS customer with no CUI): the correct
  fix is a **data/config change** — set that org's `tenantClass = COMMERCIAL`. The gate then
  EXPOSES unclassified content (`gate.ts:35`) and Cosmo sees project/member/ticket names
  normally. This is an org-classification decision for an admin, not a code change, and I did
  not touch production data.
- **If the org is genuinely gov**: the masking is correct and must stay. Cosmo now operates
  via ids + the new server-side resolver + the new prompt guidance. Optionally, a product
  decision could surface a **minimal, explicitly non-CUI** slice to the gov model (e.g.
  project display names, or member display names for assignment) by adding those fields to
  `EXPOSABLE_FIELDS` in `egress/projection.ts`. I deliberately did **not** do this: the code
  comments there classify project `name`/`key` and member `name`/`email` as sensitive for
  gov, so unmasking them is a security-policy change that needs an owner's sign-off, not a
  localized bug fix.

### CUI-blind tension, explicitly
The safe, universal fixes (identity, self-assign, server-side project resolver, prompt
guidance) let Cosmo *act* correctly without ever reading withheld content — the resolver
matches names server-side and hands back only ids. The thing that actually makes routine PM
chat feel "broken" for this user — seeing titles/names as opaque placeholders — is the gate
doing exactly what it was designed to do for a `gov` tenant. Relaxing it is a
classification/policy call (per-org `tenantClass`, or a curated non-CUI field allowlist), so
it is flagged here rather than coded.
