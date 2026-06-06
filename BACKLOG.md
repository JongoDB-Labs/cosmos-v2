# Backlog

Running list of items captured while walking through the dashboard. Newest items at the top of each section.

## Inbox (unsorted)

<!-- New items land here as they're called out. Triage into the sections below later. -->

- **UUIDs leaking into the frontend and URLs instead of human-readable names.** Seen in multiple places — e.g. user UUIDs when tagging in comments, and project/board URLs use raw IDs (`/apex-defense/projects/SENTINEL/boards/4efcfc43-f68e-4d1f-b8d2-5351ff5b6288`). **Action:** do a thorough e2e sweep to ensure no UUIDs appear in the UI or in any URL — everything user-facing should resolve to a name/slug. Covers: visible labels (mentions, assignees, owners, etc.) and route segments (boards, and audit every other `[id]`-style route). Likely needs slug fields + lookups for entities that currently route by UUID. **Confirmed sightings (keep adding as found):** mention UUIDs in comments; board UUID in URL; **project UUID shown in a dropdown** (meetings project-selector). Do a clean full scrub of all frontend-facing UUIDs.

- **[bug] Pin/unpin not working for channels.** Pinning or unpinning a channel has no effect — fix the pin/unpin behavior.

- **[bug/limit] Profile photo upload size too small.** Avatar uploads are capped at ≤200KB, which rejects normal photos (e.g. a 6447KB pic). Raise the avatar upload size limit to something reasonable (and/or auto-downscale/compress on upload so users aren't blocked).

### Integrations catalog additions
- **[integrations] Add Signal** to the Messaging & Chat category.
- **[integrations] Add Zoho Chat** (the Zoho equivalent in Messaging & Chat) — and since Zoho Mail is already included, **bring in the entire Zoho ecosystem** across the relevant integration categories (Books/finance, Mail, Chat, CRM, etc.).
- **[integrations] Add Cloudflare** offerings throughout — **R2** and **D1** under Storage, plus other Cloudflare products in their appropriate categories.
- **[integrations] Add BoldSign** (e-signature).
- **[integrations] Add Keycloak** (identity / SSO / auth provider).

- **[bug] Themes: preset selections don't apply.** In the Themes section, choosing a different preset has no effect in-app — it always stays the blue preset. Selecting a preset should actually change the app's theme colors. (Check that the selected preset is persisted and that the app reads/applies it, not a hardcoded default.)

- **[bug] Page scrolls below the navbar.** Shouldn't be able to scroll the page content down past/under the navbar — fix the scroll containment so the navbar stays fixed and content doesn't overscroll beneath it.

- **[bug/limit] Org logo upload size too small.** Logo uploads are capped at ≤200KB, rejecting normal images (e.g. a 3719KB logo). Same root issue as the avatar cap above — raise the limit and/or auto-downscale/compress on upload. Likely a shared image-upload size limit; fix both (avatar + org logo, and audit any other image upload) together.

- **[feature] Pre-canned popular MCP servers to choose from.** Add a curated catalog of popular MCP servers in the MCP section, similar to the Integrations page (browse/select from known providers instead of only manual config). Mark ones that aren't wired up yet as "Coming soon" so it's clear which are actually functional.

- **[feature] Webhooks section is thin — expand event coverage + customization.** Only 8 events are available to choose from when creating a webhook. Broaden the event catalog to cover more entity/action types across the app, and make webhooks more customizable (e.g. payload/filter options).

- **[feature] Security section — more granular controls.** The Security settings could offer finer-grained controls than it does today. (Specifics TBD — revisit to enumerate exactly which controls, e.g. session/IP/MFA/password policy, per-action restrictions, etc.)

- **[bug] Preferences: several controls are no-ops.** In the Preferences section, **density controls**, **sidebar position**, and **nav style** all have no effect when changed. They should actually alter the UI (and persist). (Possibly related to the Themes preset no-op above — appearance prefs not being read/applied.)

- **[feature] Admin-customizable navbar tabs.** Let an admin choose which tabs appear in the navbar (keep/drop), **reorder** them, and optionally **group** them. Effectively a configurable navigation layout per org.
  - **Parent groups / drill-down (Monograph style).** Group navbar items into collapsible **parent groups** that you drill into when expanding the nav — reference: https://cdn.prod.website-files.com/64ccc2cbb5ca5d428651752c/64f0fedb6b7fd4ea71b5ebdf_feature_pp_hero.png
  - **RBAC/ABAC-gated nav.** Navbar views/items should be shown/hidden based on the user's RBAC/ABAC permissions (only see what you have access to) — reference: https://gdm-catalog-fmapi-prod.imgix.net/ProductScreenshot/a7037c63-4d78-46fb-a091-75501ac0c91b.png?auto=format&q=50
  - **White-label brand slot.** A company/org should be able to put **their own logo** in the top-left where the FSC logo currently sits (per-org branding of the nav header).

- **[ux] Custom Fields & Templates are unclear / empty.** It's not obvious what Custom Fields or Templates actually provide — both should ship with example/preset entries to choose from and edit (starter templates, sample custom fields), so users understand the feature and have a starting point instead of a blank slate. Also consider inline explainer copy describing what each does.

- **[feature] Classification banner — optional + org/project ceiling.** Make the data-classification banner **optional**, toggleable per **org tenant** and per **project**. Also enforce a ceiling invariant: **a project's classification can never exceed its org tenant's classification** (org sets the max; projects can be equal or lower, never higher). Validate this on set/update for both project and org-level changes (lowering an org's classification must reconcile/clamp child projects).

- **[ux] Notes editor needs a solid writing surface.** The area being written on in Notes should have a solid (opaque) background for better text visibility/contrast, rather than a transparent/translucent surface that hurts readability.

- **[ux] Remove the purple planet icon** from throughout the UI (wherever it appears).

- **[bug] Not all roles available when creating a user.** The role selector in the create-user flow doesn't list all roles — some defined roles are missing from the dropdown. Ensure the full set of org roles (including custom ones) is selectable when creating/inviting a user.

- **[bug] Can't scroll on Project Settings.** The project settings page/panel can't be scrolled, so content below the fold is unreachable. Fix the scroll container / overflow.

- **[bug] Board list doesn't refresh after create.** Creating a board doesn't auto-refresh to show the new board — user has to manually reload. Should optimistically/automatically show the newly created board (and ideally navigate into it).

- **[bug/feature] No way to create issues.** There's no apparent way to create issues/tickets. Add issue creation, available **within each board view** (e.g. "+ Add issue" per column / quick-add), plus presumably from the org-wide Issues view.

- **[bug] Can't delete boards.** There's no working way to delete a board. Add board deletion (with appropriate permission check + confirmation).

- **[feature] Multiple boards per project + saved filter views.** Allow a project to have **multiple boards**, each defined by a **saved search/filter** (Jira-style: build a filter, save it as a board) so different audiences/levels see a tailored view. Boards become saved, shareable, permission-aware filtered views over the project's tickets.

- **[feature] Org-wide Issues view + create-board-from-search.** Add a Jira-style **Issues** view that searches **everything across the org** (all projects, epics, stories, sub-tasks, etc.) with rich filtering. From a search result you can **save it as a board** (this is the mechanism behind "multiple boards per project + saved filter views" above — boards are persisted searches). Needs a cross-project query/filter layer (think JQL-lite) and respects RBAC/ABAC so users only see issues they're permitted to.

- **[feature] Timeline / Gantt tab.** Add a **Timeline** tab that renders a **Gantt** of all tickets across the project's boards, with a **dropdown to view each board individually** on the Gantt (all-boards view + per-board view). Should respect dates/dependencies (start/due, predecessors) from the import-schema work above.

- **[feature] Configurable project boards (Jira-like).** Let users configure project boards similar to Jira: customizable **columns** (add/rename/reorder/remove, WIP limits), **swimlanes**, board/column **titles**, **visibility** settings, and other board configuration. Move boards beyond fixed presets to a fully configurable layout.

- **[bug] "Create organization" flow is broken.** Pressing **Create organization** does two wrong things: (1) all navbar buttons change to a different color **except** the Finance button (styling/active-state glitch), and (2) it shows a list of existing orgs to select from but provides **no actual option to create a new org**. Expected: a working create-org form/dialog. (Note: recent commit `5d6fd7b` "allow existing members to create additional orgs" is likely the relevant code area.)

- **[bug] FSC white logo shrinks on navbar collapse.** When collapsing the navbar/sidebar, the FSC white logo shrinks instead of staying the same size. It should keep a consistent size across expanded/collapsed states.

- **[ux] Redundant expand/collapse controls.** There's both a left/right carat (chevron) **and** a hamburger menu for expanding/collapsing the navbar — two controls doing the same thing. Consolidate to a single, clear toggle.

- **[bug] COSMOS Agent drawer UI is rough.** The current assistant drawer has layout problems — UI collisions/overlap and general jank. Needs a UI cleanup pass. (May be largely addressed by moving it to a bottom-right overlay per the rebrand/relocate item below, but the layout/collision issues should be fixed regardless.)

- **[ux] Rebrand & relocate the assistant → "COSMOS Agent" overlay.**
  - Replace the current robot-looking assistant icon (looks cheesy). For now, reuse the **star icon** already used in the navbar.
  - Rename "AI Chat" / "Assistant" to **"COSMOS Agent"** everywhere.
  - Move it off the navbar and make it a **floating overlay bubble/component anchored bottom-right** (persistent across the app), instead of a navbar entry.

- **[ux] Relocate Feedback off the navbar.** Feedback shouldn't be a navbar section. Move it to a noticeable-but-not-distracting **button** (e.g. in the topbar or a subtle persistent affordance). Look at how mature SaaS products surface feedback in production for inspiration on placement/styling.

- **[ux] Move Notes, Chat, Team, and Meetings to the top.** Take these four sections off the side navbar and place them in the topbar instead.

- **[ux] Consolidate navbar sections into parent groups.** Collapse related sections under parent groups (ties into the navbar parent-groups / drill-down item above):
  - **Accounting** — fold in Banking, Tax, Payroll, and other finance/accounting-related sections.
  - **CRM** — fold in Contacts, Clients, Partners, Sales, Invoices, and other CRM-related sections.

- **[feature] All-encompassing import schema for popular PM tools (lossless import).** Design our work-item/project schema (and an import pipeline) so we can readily import from popular project-management software **without losing any data points**. Approach: per-platform **parser/importer that transforms into OUR schema** (the Jira integration can be an import parser, not necessarily live sync). Key requirement: our schema must be a superset rich enough to absorb the fields below, with an **overflow mechanism** (e.g. custom-fields/metadata bag) so unmapped source columns are preserved rather than dropped.
  - **Sample exports to design against (in `~/`, on this machine):**
    - `~/Jira 2026-06-04T20_39_05-0500.csv` — full Jira issue export, ~37.7k rows. Standard fields: Issue Type, Summary, Status, Priority, Assignee/Reporter, Created/Updated/Resolved, **Sprint**, Labels, Components, Epic Link, **Parent**, issue **links** (Blocks, Cloners, Child/Child-Issue), **Comments** (many repeated columns), **Attachments**, Watchers, Votes, Work Ratio, time tracking (Original/Remaining Estimate, Time Spent + Σ rollups). Plus **dozens of Custom fields** (Acceptance Criteria, User Story, Success Criteria, Use Case, Sponsor, Requestor, Impact, Urgency, Mission Impact, Data Champion ×30, etc.) and **many JSM SLA fields** (Time to first response/resolution/close, Time in <status>, etc.). Note: Jira repeats columns for multi-value fields (comments/links/attachments) — importer must handle repeated headers.
    - `~/VITL-BMA_Backlog_Import_v2.0_jon_2026-06-04.csv` — the "other platform" / clean import template, ~482 rows. Columns: IssueType, ExternalID, Summary, EpicName, EpicLink, ParentID, Predecessor, LOE, Sprint, Owner, Assignee, OrgOwner, Priority, Status, StoryPoints, StartDate, DueDate, Labels, Source, Description.
  - **Schema gaps to make sure we cover:** hierarchy (Epic→Story→Sub-task / Parent), **dependencies/predecessors**, **sprints**, story points + LOE, start/due dates, multi-assignee/owner vs org-owner, issue links/relations, comments, attachments, watchers/votes, time tracking + estimates, arbitrary custom fields, and a `source`/`externalId` provenance field for re-import/round-trip.

- **[feature] Username/password login + MFA (alongside Google).** Add email/password authentication with **MFA** (e.g. TOTP) as a login option **in addition to** the existing Google sign-in. Includes signup/login, password reset, and MFA enrollment/challenge flows. (Ties into the "Security section — more granular controls" item.)

- **[feature] Mobile layout overhaul.** Rework the mobile experience:
  - **Top bar:** search bar at the top; **notifications** icon top-right.
  - **Agent:** remove the Agent item from the mobile bottom navbar — surface it as the floating **bubble** instead (consistent with the COSMOS Agent overlay item).
  - **Bottom navbar:** the most popular/routine items — **Overview, Projects, Chat, Notes, Meetings** — with **Chat in the center** (mirror everest-ai's mobile layout, `jongodb/everest-ai`).
  - **Customizable:** users can choose what appears on their mobile navbar via **Preferences** — **Chat stays fixed (center)**, the other four slots are user-customizable.

- **[feature] In-meeting Notes drawer.** During a meeting, expose **Notes as a side drawer** so attendees can take notes live without leaving the meeting view. (Tie the notes to the meeting record.)

- **[feature] Embed the live meeting in Cosmos (iframe).** Show the active **Google Meet** (or other provider) meeting **embedded via iframe** inside Cosmos during the meeting, so users can join/watch within the app alongside the notes drawer. (Verify provider embedding/iframe policies — Meet may restrict embedding; fall back to launch-in-tab if disallowed.)

- **[feature] More meeting options + user-defined meeting types.** Offer more meeting/provider options, and/or let users **add their own meeting options** to be shown in the dropdown, configurable in Settings (managed list of meeting types/providers users can extend).

- **[bug/feature] Meeting management: delete / cancel / reschedule.** Users must be able to **delete, cancel, and reschedule** meetings. Currently these actions are missing.

- **[feature] Full CRUD everywhere, gated by RBAC/ABAC.** Ensure **complete CRUD operations on every entity throughout Cosmos** — an **admin** can create/read/update/delete anything; a **user** can do most operations subject to RBAC/ABAC permissions. Audit all modules for missing delete/edit/create actions (boards, meetings, etc. found so far are symptoms of this broader gap). This is a cross-cutting completeness sweep, not a one-off.

- **[feature/convention] Right-click context menus throughout the app.** Add right-click (context-menu) functionality across the app — issues, board cards/columns, list rows, nav items, files, etc. — exposing the relevant actions (edit, delete, move, copy link, assign, etc.). **Make this a standing convention:** every new feature/component should ship with appropriate right-click context-menu support. *(Consider codifying this in AGENTS.md so it's enforced going forward.)*

- **[feature] Port full AI assistant functionality from okr-dashboard repo.** Make sure **all** assistant capabilities are carried over from the **okr-dashboard** repo, including: the **agentic framework**, **tool calling**, **attachments for RAG**, and any other assistant features. Audit okr-dashboard vs. current Cosmos assistant for parity and bring over what's missing.
  - **Showcase sub-item:** in the AI/Assistant settings section, surface a **list of the assistant's tool calls / capabilities** so users can see what it can do — with "Coming soon" markers on any not yet wired up.

- **[feature] Admin-configurable AI provider credentials in Settings.** Enable an admin to set, in the settings UI: Claude OAuth and/or Anthropic API key and/or OpenAI API key, used by the assistant. **Placement:** these AI settings should live in a relevant existing Settings section or a new dedicated AI/Assistant settings section. For the Claude OAuth token-exchange flow, refer to the **everest-ai** repo (GitHub: `jongodb/everest-ai`) — borrow its auth flow / token-exchange implementation and lessons learned, and adapt it to the Cosmos UI.

## Bugs

## Features / Enhancements

## Polish / UX

## Tech debt

---

_Started 2026-06-05._
