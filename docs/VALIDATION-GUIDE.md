# COSMOS v3.0.1 — UI/UX Validation Guide

Manual verification checklist for the audit + tracking-templates work. Open your browser to the app's public URL (or `http://localhost:3001` for dev) and walk through each section.

---

## Pre-flight

- [ ] Log out and back in (picks up the `gmail.send` OAuth scope added in slice 1)
- [ ] Check sidebar shows version `v3.0.1` next to your name
- [ ] Health endpoint returns 200: `GET /api/health`

---

## Slice 1 — Auth + Onboarding

### Login page
- [ ] Navigate to `/login` while logged out
- [ ] Verify the Google sign-in button works
- [ ] Manually append `?error=rate_limited` to the URL — should show "Too many sign-in attempts. Please wait a moment and try again."
- [ ] Also try `?error=not_allowed`, `?error=invalid_state`, `?error=auth_failed` — each should show distinct copy

### Invite flow (`/[orgSlug]/team`)
- [ ] Navigate to your org's Team page
- [ ] "Invite member" button should be visible (you're OWNER)
- [ ] Click it — dialog opens with email + role select
- [ ] Submit with a test email — should create invite + show accept URL
- [ ] Copy the URL — it should be a valid `/login?invite=<token>` link
- [ ] If Gmail send failed (expected until re-login), an error message should appear with the copy-link fallback
- [ ] Click "Invite another" to reset the form
- [ ] Close dialog, verify the pending invite appears in the team table with "Pending" badge
- [ ] Toast notification should appear (success or warning depending on email delivery)

### Onboarding
- [ ] If testing with a fresh user: sign in → should redirect to `/onboarding` (no org membership yet)
- [ ] Create an org → confetti fires → redirects to org overview

---

## Slice 2 — Org Overview + Projects

### Org overview (`/[orgSlug]`)
- [ ] Shows stat cards: Active projects, Team members, Plan
- [ ] "New project" button links to `/[orgSlug]/projects/new`
- [ ] Project grid shows active projects (or empty state)
- [ ] Empty state copy: "Create your first project to start tracking work." (NOT "sprints, OKRs, and work items")

### Projects list (`/[orgSlug]/projects`)
- [ ] Shows all active projects in a grid
- [ ] Empty state copy: "Projects organize your work with boards, timelines, and dashboards." (neutral, not software-flavored)

---

## Slice 3/4 — Tracking Templates (the big one)

### Project creation wizard (`/[orgSlug]/projects/new`)
- [ ] **Step 1 — Sector picker**: 7 sector tiles visible:
  - Software (code icon)
  - Architecture & Engineering (building icon)
  - IT Operations (server icon)
  - Consulting (briefcase icon)
  - Manufacturing (factory icon)
  - Education (graduation cap icon)
  - Event Planning (party popper icon)
  - "Start from scratch" option at the bottom
- [ ] Each tile has a name + 1-line description
- [ ] Clicking a sector advances to step 2
- [ ] "Start from scratch" skips to step 3 (or 2-of-2)

- [ ] **Step 2 — Template picker**: Shows templates filtered to the chosen sector
  - "Empty project" is always the first option
  - Each template card shows name, description, board count
  - Clicking one advances to step 3
  - "Back" button returns to step 1

- [ ] **Step 3 — Project metadata**:
  - Name field (auto-generates slug below)
  - Key field (uppercase, auto-derived from name)
  - Description (optional)
  - If a template was selected: preview panel shows which boards will be created
  - Submit → creates project → redirects to project page
  - Verify the created project has the expected boards (check board tabs)

### Template gallery (`/[orgSlug]/settings/templates`)
- [ ] Navigate to Settings → Templates
- [ ] "Built-in" tab shows 7 sector templates
- [ ] Each card shows: name, sector badge, board count, work-item-type count
- [ ] Click "Clone" on a built-in → dialog asks for a name → creates an org-owned copy
- [ ] Switch to "Org templates" tab → the clone appears
- [ ] Click "Edit" on the clone → template editor opens

### Template editor (`/[orgSlug]/settings/templates/[id]`)
- [ ] **For built-in templates**: shows read-only mode with a "Clone to edit" button
- [ ] **For org-owned templates**: shows editable form:
  - Name, sector, description inputs
  - Enabled features checkboxes (goal, milestone, kpi, risk, decision, meeting_note, okr, cycle)
  - Board templates list (read-only, shows name + board type)
  - Work item types list (read-only, shows icon + name + color + parent hint)
  - Save button → persists changes

### Board tabs (conditional features)
- [ ] Create a project from the **Software** template → board tabs should show boards + optionally Goals, Milestones tabs (if enabled)
- [ ] Create a project from the **AEC** template → tabs should NOT show "Sprints" — should show "Phases" instead (or cycle nav based on template config)
- [ ] OKRs tab should NOT appear unless explicitly enabled (off by default for all sectors)

### Widget palette (`/[orgSlug]/projects/[key]/boards/[id]/builder`)
- [ ] Open the dashboard builder on any DASHBOARD-type board
- [ ] Widget palette should show 4 categories: Data, Time, Content, Interactive
- [ ] ~21 generic widgets available
- [ ] If a sector is associated: "Sector Skins" section appears at the bottom with sector-specific presets

---

## Slice 5 — CRM + Meetings + Time + Notes

### CRM (`/[orgSlug]/crm`)
- [ ] Page renders with contact list (empty or populated)
- [ ] Pipeline view renders
- [ ] Try creating a contact with invalid data → should show 400 validation errors

### Meetings (`/[orgSlug]/meetings`)
- [ ] Page renders
- [ ] Meeting list shows (empty state if none)

### Time Tracking (`/[orgSlug]/time-tracking`)
- [ ] Page renders with time entry list
- [ ] Try creating an entry — form validates (hours + date required)

### Notes (`/[orgSlug]/notes`)
- [ ] Page renders
- [ ] Try creating a note with NO title → should now fail with "Title is required" (was previously allowing empty)
- [ ] Create a note with a title → succeeds

---

## Slice 6 — Finance + Analytics + Reports

### Finance (`/[orgSlug]/finance`)
- [ ] Page renders with revenue/expense summary
- [ ] Monthly chart uses design tokens (no hardcoded hex colors)
- [ ] Try creating an expense → validates required fields

### Analytics (`/[orgSlug]/analytics`)
- [ ] Page renders
- [ ] Portfolio view loads (empty or populated)
- [ ] Charts render with themed colors (dark/light mode consistent)

---

## Slice 7 — Settings Hub

Walk through each settings sub-page and verify it renders:

- [ ] `/settings/profile` — profile form
- [ ] `/settings/preferences` — user preferences
- [ ] `/settings/themes` — theme management
- [ ] `/settings/custom-fields` — custom field definitions
- [ ] `/settings/templates` — **NEW** template gallery (tested above)
- [ ] `/settings/security` — SSO, sessions, IP allowlist, SCIM
- [ ] `/settings/compliance` — compliance controls
- [ ] `/settings/classifications` — data classifications
- [ ] `/settings/integrations` — integration management
- [ ] `/settings/webhooks` — webhook configuration
- [ ] `/settings/audit-logs` — audit trail viewer

---

## Slice 8 — Admin + Design System + Chat

### Admin allowlist (`/admin/allowlist`)
- [ ] Only accessible to OWNER users
- [ ] Shows the list of allowed emails
- [ ] Can add/remove emails

### Chat (`/[orgSlug]/chat`)
- [ ] Chat page renders
- [ ] Can start a conversation (if Claude CLI is configured)
- [ ] Rate-limited at 20 messages per 40 seconds per user

### Design system (`/internal/design-system`)
- [ ] Token gallery renders
- [ ] Component examples display correctly

---

## Cross-cutting checks

### Security headers
- [ ] Open browser DevTools → Network → check response headers on any page:
  - `Content-Security-Policy` present
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Strict-Transport-Security` present
  - `Referrer-Policy: strict-origin-when-cross-origin`

### Dark/light mode
- [ ] Toggle theme — all pages should respect the switch
- [ ] Charts, badges, cards should use CSS custom properties (no flashing/wrong colors)

### Mobile responsiveness
- [ ] Resize browser to mobile width (~375px)
- [ ] Sidebar collapses
- [ ] Dialogs render as bottom sheets
- [ ] Project wizard steps are usable on mobile

### Error handling
- [ ] Navigate to a non-existent org slug → should redirect to `/` or show error
- [ ] Navigate to a non-existent project → should show 404 / not-found page
- [ ] The error boundary should catch and display errors with "Retry" + "Back home" buttons

---

## Known limitations (not bugs — intentional deferrals)

1. **No DELETE/cancel invitation endpoint** — admins must clean up stale invites via DB
2. **OKR components** (`/[orgSlug]/projects/[key]/okrs`) — compile but won't function at runtime (old endpoints removed; OKR data is now in WorkItems under Goals)
3. **Sprint-complete UI** — API exists (`POST /cycles/[id]/complete`) but no UI flow yet
4. **Template editor** — board templates and work item types lists are read-only in v1; full editing comes later
5. **Sector-skin widgets** — palette entries exist but most don't have functional data sources yet (they're config presets for generic widget types)
6. **Gmail invite send** — requires re-login to pick up `gmail.send` scope; fails gracefully with copy-link fallback
