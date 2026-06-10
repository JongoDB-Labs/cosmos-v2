# Backlog

Running list of items captured while walking through the dashboard. Newest items at the top of each section.

**Status legend (marked by COSMOS Agent):** ✅ done & deployed (prod at 2.68.1) · 🟡 partial / verify · ⬜ open (not started). Version in _italics_ = where it shipped.

## Inbox (unsorted)

<!-- New items land here as they're called out. Triage into the sections below later. -->

- ✅ **[qa] Settings subsection end-to-end audit (~20 subsections).** _(done 2026-06-09 — parallel-agent audit of every Settings subsection + the two access-control ones by hand.)_ **Verdict: zero stubs — every subsection (agent-governance, agent-policy, ai, audit-logs, classifications, compliance, custom-fields, integrations, mcp-servers, preferences, profile, roles, runtime-config, security, templates, themes, webhooks, org-general, project-settings) is genuinely wired UI→route→DB→read-back with `requirePermission` gating.** Shipped fixes in **2.57.0**: (1) **AI settings** page gated `INTEGRATION_MANAGE` but all `/ai/*` routes enforce `ORG_MANAGE_SETTINGS` → aligned the page to the routes; (2) **Security** page now gates the org-policy section on `SECURITY_MANAGE` (EmptyState for members; personal account panel still shown) instead of letting the panel error out; (3) **audit-log export** now mirrors the list's action/entity/userId filters (was date-only → exports silently broader than the filtered view); (4) **classifications** Scope column renders the project name+key, not a raw UUID; (5) **webhooks** list GET + SSR prefetch `select`-exclude the sealed `secret` envelope; (6) **mcp-servers** edit no longer wipes env/headers (GET can't repopulate sealed values, so empty-on-PATCH = keep; non-empty = replace) + a "leave blank to keep" hint. **Deferred minors (UX/convention, not bugs):** themes/templates/project-settings render mutating controls to users lacking the permission and rely on the server 403+toast (project-settings specifically shows project-MANAGERs disabled toggles the API would now allow — same root as the create-board item below); integrations + custom-fields managers use raw `fetch` instead of `useOrgMutation`/`useOrgQueryKey` (bypass org-scoped cache); MCP runtime execution is still dormant (config CRUD persists but no live consumer); classifications "Add" is upsert-by-scope (silently updates an already-classified scope).

- ✅ **[security, HIGH] Request-time enforcement of org `mfaRequired` (the missing assurance gate).** _(done — `getAuthContext()` now reads `OrgSecuritySettings.mfaRequired` and DENIES (null → 401) a session that doesn't satisfy the org's MFA floor, under a provider-trusted policy (federated logins trusted, first-party password requires `mfaSatisfied`); `INTERNAL_ADMINS` break-glass exempt; per-user MFA enroll uses `getCurrentUser()` so a denied user can still enroll. Shipped 2.48.0. The IP-allowlist gate landed alongside it in `getAuthContext()` — 2.54.0 — with `cf-connecting-ip`-first trusted-IP derivation, 2.55.0.)_ Residual follow-ups (not blocking): a **lockout warning before disabling MFA** in the Security UI; optional **TOTP replay-within-window rejection**; and `proxy.ts`-level step-up **redirect** for dashboard PAGE navigations (today an unsatisfied page request 401s via the context rather than redirecting to a friendly step-up/enroll screen).

- ✅ **[ux, LOW] Create-board button gated correctly for project MANAGERs.** _(done 2.66.1 — server-side fix, the cleaner direction.)_ The project layout now computes `canCreateBoards` (org `BOARD_CREATE` **or** project MANAGER, mirroring the boards POST gate) and threads it into the board-tabs — so a VIEWER/GUEST who manages a project sees "New Board", while a true read-only role doesn't. The `/boards/new` page got the same guard (a non-creator is redirected back rather than landing on a gallery that 403s on submit). Note: this gated the **board-tabs** "New Board" (the project boards strip); the org-wide Issues view's create affordance already gates on `BOARD_CREATE` and is unaffected.

- ⬜ **[feature] Bulk-edit issues (okr-dashboard parity).** Borrow lessons from the okr-dashboard repo — notably **bulk edit of issues** on the Issues page AND across all board types (multi-select rows/cards → bulk change status/assignee/priority/etc.). Sweep okr-dashboard for other reusable UX wins while at it.
- ✅ **[bug] Backlog scroll escapes its container over the navbar.** _(done 2.64.11.)_ Root cause traced via DOM: a nested `overflow:auto` `<main>` propagated its overflow to the documentElement in Chromium even though every app-level ancestor clipped at 100vh — so any tall page (Settings, long lists) left the *viewport* scrollable and wheeling over the fixed topbar scrolled the whole document into empty space. Fixed by locking the document scroller (`html`/`body` `overflow:hidden`) while the dashboard shell is mounted, so `<main>` is the only scroll surface; scoped to the dashboard so login/marketing pages keep document scroll. Verified `window.scrollY` stays 0 over the topbar on 5 routes while `<main>` still scrolls its content.
- ✅ **[bug] Classification banner + UUID-in-modal.** _(done 2.64.8 + verified.)_ Root cause of the UUIDs: `<Select>`'s auto-derived label map only captured items whose child was a *single* string, so an interpolated `{key} - {name}` (which JSX compiles to an array) was skipped and base-ui's `<Select.Value>` fell back to the raw value — fixed `collectSelectItems` to flatten array children, which repairs the Add-Classification project selector AND the meetings selector AND any interpolated-label select app-wide. The per-project **banner was verified working** (renders for FOUO+; UNCLASSIFIED/PUBLIC intentionally show nothing — the "not appearing" note was stale).
- 🟡 **[feature] Fully configurable dashboard widgets.** _(partial — a configurable system EXISTS: Home → "Add widget" adds/removes/persists widgets via `/home-widgets` from a catalog, currently 5 portfolio/member metric cards.)_ Open expansion: broaden the catalog to ANY page/section/data in the app (sprint velocity, my-assigned-items, recent activity, finance KPIs, etc.) — i.e. drive the widget catalog from the real surface area, not just the portfolio metrics. The add/remove/persist plumbing is done; this is purely adding widget types + their data sources.
- ⬜ **[feature] Platform/sysadmin analytics + richer bug/FR telemetry.** Expand Analytics to cover platform/sysadmin metrics: track **reported / open / resolved bugs AND feature requests** so users have visibility into problems being fixed + features requested. Autonomously collect a useful metric/datapoint/console snapshot/etc. from the user's session to attach to each submitted bug report. Let users **attach screenshots** to either ticket type (bug or FR), viewable via a portal/section on the Analytics page. (Bug-report submit is already wired → FeedbackItem; this is the analytics + telemetry + attachment layer on top.)
- 🟡 **[qa] Connector end-to-end test + usage docs.** _(usage-docs part done 2.68.1 — every provider card now shows a "Setup guide" link to that vendor's official setup/API docs; ~180 connectors carried a `docsUrl` the UI never rendered.)_ Open: the **end-to-end test** that each connector (Google, GitHub, Jira, Slack, M365) actually completes its connect flow and the agent/app can act on it — most are `coming_soon` in the catalog (only Google is `available` + wired), so this is really "finish wiring the others," not just test.
- ⬜ **[qa] Walkthrough demo using the demo project seed data.** Produce a guided walkthrough/demo script driven by the apex-defense demo seed.
- ⬜ **[qa] Validate EVERY Settings subsection end-to-end from the frontend.** Determine whether **Security → SSO / sessions / IP allowlists** (and every other settings subsection) is actually wired up + working from the UI. Iterate through each subsection; where UI components are missing for functionality/visibility, add them.
- ✅ **[feature] Chat revamp → Teams/Mattermost-style.** _(done 2.65.0.)_ Own messages now mirror to the RIGHT in a primary-tinted bubble; everyone else (and the 🤖 Assistant) stays on the LEFT in a neutral bubble, with avatars + timestamps mirrored. Read receipts already existed (`ReadReceiptAvatars`). Mobile-friendly: tapping "Chat" in the bottom nav opens the full-screen chat drawer (was the orphaned `/chat` page). Verified live with two users.
- ✅ **[feature] Mobile navbar layout (everest-ai-style).** _(already matches — confirmed.)_ The mobile bottom nav is exactly: Overview · Projects · **Chat (center)** · Notes · Meetings — Overview+Projects left, Meetings+Notes right, Chat centered, with the Agent as a separate floating bubble.

- 🟡 **UUIDs leaking into the frontend and URLs instead of human-readable names.** _(mostly done v4.18.0 — uuid→slug sweep: comment/note mentions render names, board/chat/template URLs route by slug with UUID→slug redirects, ~18 raw-UUID label fallbacks fixed across board views/payroll/security/meetings; OPEN: the newly-noted **project UUID in the meetings project-selector dropdown** — re-verify/close.)_ Seen in multiple places — e.g. user UUIDs when tagging in comments, and project/board URLs use raw IDs (`/apex-defense/projects/SENTINEL/boards/4efcfc43-f68e-4d1f-b8d2-5351ff5b6288`). **Action:** do a thorough e2e sweep to ensure no UUIDs appear in the UI or in any URL — everything user-facing should resolve to a name/slug. Covers: visible labels (mentions, assignees, owners, etc.) and route segments (boards, and audit every other `[id]`-style route). Likely needs slug fields + lookups for entities that currently route by UUID. **Confirmed sightings (keep adding as found):** mention UUIDs in comments; board UUID in URL; **project UUID shown in a dropdown** (meetings project-selector). Do a clean full scrub of all frontend-facing UUIDs.

- ✅ **[bug] Pin/unpin not working for channels.** _(done v4.15.0 — per-user `pinned` on ChatChannelMember + toggle route + pinned-first sidebar ordering.)_ Pinning or unpinning a channel has no effect — fix the pin/unpin behavior.

- ✅ **[bug/limit] Profile photo upload size too small.** _(done v4.14.0 — client downscale + raised caps.)_ Avatar uploads are capped at ≤200KB, which rejects normal photos (e.g. a 6447KB pic). Raise the avatar upload size limit to something reasonable (and/or auto-downscale/compress on upload so users aren't blocked).

### Integrations catalog additions
- ✅ **[integrations] Add Signal** to the Messaging & Chat category. _(done v4.14.0)_
- ✅ **[integrations] Add Zoho Chat** _(done v4.14.0 — Zoho Cliq + ecosystem entries added)_ (the Zoho equivalent in Messaging & Chat) — and since Zoho Mail is already included, **bring in the entire Zoho ecosystem** across the relevant integration categories (Books/finance, Mail, Chat, CRM, etc.).
- ✅ **[integrations] Add Cloudflare** offerings throughout — **R2** and **D1** under Storage, plus other Cloudflare products in their appropriate categories. _(done v4.14.0)_
- ✅ **[integrations] Add BoldSign** (e-signature). _(done v4.14.0)_
- ✅ **[integrations] Add Keycloak** (identity / SSO / auth provider). _(done v4.14.0)_

- ✅ **[bug] Themes: preset selections don't apply.** _(done v4.14.0 — root cause: an untagged `use cache` org-theme read; fixed to the cache-tagged lookup + router.refresh.)_ In the Themes section, choosing a different preset has no effect in-app — it always stays the blue preset. Selecting a preset should actually change the app's theme colors. (Check that the selected preset is persisted and that the app reads/applies it, not a hardcoded default.)

- ✅ **[bug] Page scrolls below the navbar.** _(done v4.14.0 — scroll containment in dashboard-shell.)_ Shouldn't be able to scroll the page content down past/under the navbar — fix the scroll containment so the navbar stays fixed and content doesn't overscroll beneath it.

- ✅ **[bug/limit] Org logo upload size too small.** _(done v4.14.0 — same shared downscale fix as the avatar.)_ Logo uploads are capped at ≤200KB, rejecting normal images (e.g. a 3719KB logo). Same root issue as the avatar cap above — raise the limit and/or auto-downscale/compress on upload. Likely a shared image-upload size limit; fix both (avatar + org logo, and audit any other image upload) together.

- ✅ **[feature] Pre-canned popular MCP servers to choose from.** _(done v4.15.0 — curated catalog; only `npm view`-verified-published servers marked "available", rest "Coming soon".)_ Add a curated catalog of popular MCP servers in the MCP section, similar to the Integrations page (browse/select from known providers instead of only manual config). Mark ones that aren't wired up yet as "Coming soon" so it's clear which are actually functional.

- ✅ **[feature] Webhooks section is thin — expand event coverage + customization.** _(done v4.15.0 — categorized, real-emit-only event catalog.)_ Only 8 events are available to choose from when creating a webhook. Broaden the event catalog to cover more entity/action types across the app, and make webhooks more customizable (e.g. payload/filter options).

- ✅ **[feature] Security section — more granular controls.** _(done v4.20.0 — session policy [age/idle/max-concurrent], IP allowlist [CIDR] with anti-lockout, per-action restrictions ENFORCED via the central requirePermission gate; MFA = flag-and-stub [needs enrollment infra]; password policy = "managed by Google" since OAuth-only.)_ The Security settings could offer finer-grained controls than it does today. (Specifics TBD — revisit to enumerate exactly which controls, e.g. session/IP/MFA/password policy, per-action restrictions, etc.)

- ✅ **[bug] Preferences: several controls are no-ops.** _(done v4.16.0 — PreferencesProvider applies density/sidebar-position/nav-style.)_ In the Preferences section, **density controls**, **sidebar position**, and **nav style** all have no effect when changed. They should actually alter the UI (and persist).

- ✅ **[feature] Admin-customizable navbar tabs.** _(done v4.16.0 — nav-IA overhaul: per-org nav config, reorder, groups.)_ Let an admin choose which tabs appear in the navbar (keep/drop), **reorder** them, and optionally **group** them. Effectively a configurable navigation layout per org.
  - ✅ **Parent groups / drill-down (Monograph style).** _(done v4.16.0)_ Group navbar items into collapsible **parent groups** that you drill into when expanding the nav.
  - ✅ **RBAC/ABAC-gated nav.** _(done v4.16.0 — items filtered by usePermissions.)_ Navbar views/items shown/hidden based on the user's RBAC/ABAC permissions.
  - ✅ **White-label brand slot.** _(done v4.16.0 — per-org logoUrl in the brand slot.)_ A company/org can put their own logo top-left.

- ✅ **[ux] Custom Fields & Templates are unclear / empty.** _(done v4.15.0 — starter presets + explainer copy.)_ It's not obvious what Custom Fields or Templates provide — both ship with example/preset entries + inline explainer copy.

- ✅ **[feature] Classification banner — optional + org/project ceiling.** _(done v4.17.0 — org = CEILING [clamp children down, 422 over-ceiling, CUI+ force-show], optional banner toggle per org/project.)_ Make the data-classification banner **optional**, toggleable per **org tenant** and per **project**. Enforce a ceiling invariant: a project's classification can never exceed its org's (org sets the max). Validate on set/update for both; lowering an org's classification reconciles/clamps child projects.

- ✅ **[ux] Notes editor needs a solid writing surface.** _(done v4.14.0 — opaque theme-aware surface.)_ The writing area should have a solid (opaque) background for readability.

- ✅ **[ux] Remove the purple planet icon** from throughout the UI. _(done v4.14.0 — removed the default OrbitIllustration from empty-states.)_

- ⬜ **[bug] Not all roles available when creating a user.** _(open — not started.)_ The role selector in the create-user flow doesn't list all roles — some defined roles are missing from the dropdown. Ensure the full set of org roles (including custom ones) is selectable when creating/inviting a user.

- ✅ **[bug] Can't scroll on Project Settings.** _(verified scrollable 2026-06-10.)_ The project layout's content wrapper (`flex-1 min-h-0 overflow-y-auto`) scrolls correctly — measured `scrollHeight 1163 > clientHeight 730` on `/projects/TEST/settings`, content below the fold reachable. Likely resolved alongside the 2.64.11 document-scroll-lock (which stopped the viewport from fighting `<main>`'s nested scroller). Re-open if a specific viewport/section still can't scroll.

- 🟡 **[bug] Board list doesn't refresh after create.** _(verify — board create + navigate was added with saved-views v4.19.0; confirm the list auto-refreshes / optimistically shows the new board.)_ Creating a board doesn't auto-refresh to show the new board — user has to manually reload. Should optimistically/automatically show the newly created board (and ideally navigate into it).

- 🟡 **[bug/feature] No way to create issues.** _(partial — per-column quick-create exists in kanban [card-quick-create]; the org-wide Issues view doesn't yet create. Verify discoverability + add "+ Add issue" affordances/create-from-Issues.)_ There's no apparent way to create issues/tickets. Add issue creation, available **within each board view** (e.g. "+ Add issue" per column / quick-add), plus from the org-wide Issues view.

- 🟡 **[bug] Can't delete boards.** _(verify — board delete IS implemented in `board-tabs.tsx`: a per-board delete with a confirmation dialog (`boardToDelete`/`handleDeleteBoard`), gated by `canManageBoards` = org `BOARD_DELETE` or project MANAGER. Confirm the delete action works end-to-end in the UI; the note that it "wasn't added" is stale.)_

- ✅ **[feature] Multiple boards per project + saved filter views.** _(done v4.19.0 — saved-filter boards: a board can be defined by a persisted WorkItemFilter in Board.config; RBAC-scoped.)_ Allow a project to have **multiple boards**, each defined by a **saved search/filter** (Jira-style: build a filter, save it as a board). Boards become saved, shareable, permission-aware filtered views.

- ✅ **[feature] Org-wide Issues view + create-board-from-search.** _(done v4.18.0 Issues/JQL-lite + v4.19.0 "Save as board".)_ A Jira-style **Issues** view that searches everything across the org with rich filtering, RBAC/ABAC-scoped; **save a search as a board** (the mechanism behind multiple-boards-per-project). Cross-project JQL-lite query layer.

- ✅ **[feature] Timeline / Gantt tab.** _(done v4.18.0 — TIMELINE board type renders a Gantt by start/due + WorkItemLink predecessor arrows + Epic/Story/Sub-task grouping; all-boards + per-board dropdown.)_ Renders a Gantt of all tickets across the project's boards, respecting dates/dependencies.

- ✅ **[feature] Configurable project boards (Jira-like).** _(done v4.16.0 — in-board column add/rename/reorder/remove + WIP limits + safe item-reassignment on delete; swimlanes shipped earlier.)_ Configure boards like Jira: customizable columns, swimlanes, titles, visibility.

- ✅ **[bug] "Create organization" flow is broken.** _(done v4.16.0 — root cause was the active-highlight logic mis-lighting when there's no org context [on /onboarding]; fixed by deriving the org from a matched membership. The create option [OrgSwitcher → /onboarding] verified working.)_ Pressing **Create organization** lit up all navbar buttons except Finance (active-state glitch) + appeared to offer no create option.

- ✅ **[bug] FSC white logo shrinks on navbar collapse.** _(done v4.16.0 — constant-size brand logo.)_ The logo now keeps a consistent size across expanded/collapsed states.

- ✅ **[ux] Redundant expand/collapse controls.** _(done v4.16.0 — consolidated to a single toggle.)_ There were both a chevron and a hamburger doing the same thing.

- 🟡 **[bug] COSMOS Agent drawer UI is rough.** _(largely addressed v4.16.0 by moving it to a bottom-right floating bubble overlay; verify no residual layout collisions.)_ The assistant drawer had layout problems — collisions/overlap/jank.

- ✅ **[ux] Rebrand & relocate the assistant → "COSMOS Agent" overlay.** _(done v4.16.0 — star icon, renamed "COSMOS Agent" everywhere, floating bottom-right bubble [not a nav entry].)_
  - ✅ Replace the robot icon with the **star icon**. _(done)_
  - ✅ Rename "AI Chat" / "Assistant" → **"COSMOS Agent"** everywhere. _(done)_
  - ✅ Move it off the navbar to a **floating overlay bubble anchored bottom-right**. _(done)_

- ✅ **[ux] Relocate Feedback off the navbar.** _(done v4.16.0 — subtle topbar button.)_ Feedback moved off the navbar to a topbar affordance.

- ✅ **[ux] Move Notes, Chat, Team, and Meetings to the top.** _(done v4.16.0 — moved to the topbar; reachable on mobile via the drawer.)_

- ✅ **[ux] Consolidate navbar sections into parent groups.** _(done v4.16.0.)_
  - ✅ **Accounting** — folds Banking, Tax, Payroll, Finance, Ledger. _(done)_
  - ✅ **CRM** — folds Contacts, Partners, Products, Contracts, Invoices. _(done)_

- ✅ **[feature] All-encompassing import schema for popular PM tools (lossless import).** _(done — v4.17.0 WorkItem superset schema [provenance/links/attachments/time-tracking/overflow bag] + Jira/VITL importer; v4.20.0 reworked into a NATIVE per-project, **schema-on-read** importer: dynamic parser + semantic auto-mapping [keyword/header guess] + a remap/rename UI + lossless overflow → sourceRecord. Validated against the real Jira [876-col] + VITL headers.)_ Our work-item/project schema is a superset rich enough to absorb any PM export, with an overflow mechanism so unmapped columns are preserved.
  - **Sample exports to design against (in `~/`, on this machine):**
    - `~/Jira 2026-06-04T20_39_05-0500.csv` — full Jira issue export, ~37.7k rows (collapses to ~338 logical issues). Standard fields + dozens of custom fields + JSM SLA fields; repeated columns for multi-value fields.
    - `~/VITL-BMA_Backlog_Import_v2.0_jon_2026-06-04.csv` — ~482 rows. Columns: IssueType, ExternalID, Summary, EpicName, EpicLink, ParentID, Predecessor, LOE, Sprint, Owner, Assignee, OrgOwner, Priority, Status, StoryPoints, StartDate, DueDate, Labels, Source, Description.
  - **Schema gaps covered:** hierarchy (Epic→Story→Sub-task/Parent), dependencies/predecessors, sprints, story points + LOE, start/due dates, multi-assignee/owner, issue links, comments, attachments, time tracking + estimates, arbitrary custom fields, and `source`/`externalId` provenance.

- ✅ **[feature] Username/password login + MFA (alongside Google).** _(done v2.41.0 — first-party email/password auth (scrypt, 12-char policy) + TOTP MFA (RFC-6238, single-use sha256 recovery codes) for EXISTING users; set password + enroll in Settings→Security; login = email/password → optional 6-digit code. SSO-bypass closed (gov SSO-only orgs reject password login), disable requires a possession factor (live TOTP or recovery code, never password alone), per-IP + per-account rate limiting, timing-safe throughout. No new-user signup/reset by design. **Request-time org-`mfaRequired` ENFORCEMENT deferred — see the HIGH item at the top (pre-existing platform gap).**)_ Add email/password authentication with **MFA** (TOTP) as a login option **in addition to** Google sign-in.

- ⬜ **[feature] Mobile layout overhaul.** _(open — not started.)_ Rework the mobile experience:
  - **Top bar:** search bar at the top; **notifications** icon top-right.
  - **Agent:** remove the Agent item from the mobile bottom navbar — surface it as the floating **bubble** instead.
  - **Bottom navbar:** Overview, Projects, **Chat (center)**, Notes, Meetings (mirror everest-ai's mobile layout, `jongodb/everest-ai`).
  - **Customizable:** users choose mobile-navbar items via Preferences — Chat stays fixed center, the other four are user-customizable.

- ⬜ **[feature] In-meeting Notes drawer.** _(open — not started.)_ During a meeting, expose **Notes as a side drawer** for live note-taking, tied to the meeting record.

- ⬜ **[feature] Embed the live meeting in Cosmos (iframe).** _(open — not started; verify Meet embedding policy, fall back to launch-in-tab.)_ Show the active Google Meet meeting embedded via iframe inside Cosmos.

- ⬜ **[feature] More meeting options + user-defined meeting types.** _(open — not started.)_ Offer more meeting/provider options and let users add their own meeting types in Settings.

- ⬜ **[bug/feature] Meeting management: delete / cancel / reschedule.** _(open — not started.)_ Users must be able to delete, cancel, and reschedule meetings.

- ⬜ **[feature] Full CRUD everywhere, gated by RBAC/ABAC.** _(open — cross-cutting sweep; partially advanced by per-entity work but not audited end-to-end. The board-delete / meeting-CRUD / roles-dropdown items above are symptoms.)_ Ensure complete CRUD on every entity throughout Cosmos, admin = full, user = RBAC/ABAC-gated. Audit all modules for missing delete/edit/create.

- ⬜ **[feature/convention] Right-click context menus throughout the app.** _(open — not started; consider codifying in AGENTS.md.)_ Add right-click context menus across the app (issues, board cards/columns, list rows, nav, files) exposing relevant actions. Make it a standing convention.

- 🟡 **[feature] Port full AI assistant functionality from okr-dashboard repo.** _(partial — the tool-call **showcase** sub-item shipped v4.15.0; an audit found Cosmos's assistant already EXCEEDS okr-dashboard [agent loop, ~31 tools, MCP, streaming]. The genuine remaining gaps = binary/image attachments + real vector RAG → **Batch 7, in progress**.)_ Carry over all assistant capabilities (agentic framework, tool calling, attachments-for-RAG).
  - ✅ **Showcase sub-item:** list the assistant's tool calls/capabilities in AI/Assistant settings with "Coming soon" markers. _(done v4.15.0)_

- ✅ **[feature] Admin-configurable AI provider credentials in Settings.** _(done — v4.16.0 Slice 1 [encrypted AES-256-GCM Anthropic key + Claude OAuth token, masked UI] + v4.20.0 Slice 2 [callAi provider abstraction + OpenAI provider + Claude OAuth exchange/refresh + per-org provider selection]. Note: needs `COSMOS_SECRETS_KEY` set in prod env; Claude OAuth endpoint specifics flagged as needing the everest-ai details.)_ Admin sets Claude OAuth and/or Anthropic API key and/or OpenAI API key, used by the assistant.

## Bugs

## Features / Enhancements

## Polish / UX

## Tech debt

---

_Started 2026-06-05._
</content>
