# COSMOS Settings — Comprehensive Validation Plan

**Purpose:** validate that every interactive control on every settings page actually persists, applies live, and round-trips through reload. Hand this to a testing session — every checkbox below is exercised end-to-end.

**Scope:** all routes under `/[orgSlug]/settings/*` plus user-level controls in the topbar user menu. Every button, every input, every toggle.

**Driver assumptions:**
- Signed in as OWNER (has all permissions). If testing role gating, sign in as MEMBER and VIEWER for each section.
- App version reported by `GET /api/health` matches the build you're validating.
- Browser DevTools Network tab open throughout to verify each interaction fires the expected request.

---

## How to use this plan

For every step:
1. Perform the action.
2. Verify the **expected request** in the Network panel (method, URL, status).
3. Verify the **expected DOM/UI change**.
4. **Hard-refresh the page** (Cmd/Ctrl+Shift+R) and verify the change persists.

Mark each row: ✅ pass / ❌ fail (with notes) / ⏭ skip (with reason).

---

## Section 1 — User Menu (topbar)

Path: click avatar in top-right.

| # | Action | Expected request | Expected UI | Persistence |
|---|--------|-------|-------------|-----|
| 1.1 | Click "Light" theme toggle | none (cookie set client-side) | App switches to light immediately; nebula bg hidden, gradient bg visible | Reload: still light |
| 1.2 | Click "Dark" theme toggle | none | App switches to dark; nebula bg + dark overlay | Reload: still dark |
| 1.3 | Click "System" (if exposed in menu) | none | App matches OS pref | Reload: still system |
| 1.4 | Toggle wake-word / voice | POST /api/v1/me or similar | Mic icon state changes | Reload: same state |
| 1.5 | Click "Sign out" | POST /api/auth/logout 200 | Redirect to /login | n/a |

---

## Section 2 — `/settings/profile`

| # | Control | Action | Expected request | Expected UI | Persistence |
|---|---------|--------|-------|-------------|-----|
| 2.1 | Display name input | Change to "Test Name" → click Save | PATCH /api/v1/me 200 | Toast: saved; sidebar shows new name | Reload: name still "Test Name" |
| 2.2 | Avatar upload | Click avatar → pick image | PATCH /api/v1/me 200 with `avatarUrl` | New avatar shows in sidebar + topbar | Reload: same avatar |
| 2.3 | Avatar remove (if present) | Click "Remove" | PATCH /api/v1/me with `avatarUrl: null` | Falls back to initials | Reload: still initials |
| 2.4 | Cancel/Reset button | Make a change, click Cancel | none | Form reverts | n/a |

---

## Section 3 — `/settings/preferences` (the big one)

**This page now uses preview-then-save semantics.** Every change previews instantly; a sticky "Unsaved changes" bar appears at the bottom; nothing is persisted until Save is clicked.

### 3.1 Appearance — Theme mode

| # | Action | Live preview | Sticky bar appears? | Click Save | Reload |
|---|--------|--------------|---------------------|------------|--------|
| 3.1.1 | Click "Light" | Light theme applies instantly | Yes | PUT /preferences with `themeMode: "LIGHT"` | Reload: still light |
| 3.1.2 | Click "Dark" | Dark theme applies | Yes | PUT with `themeMode: "DARK"` | Reload: still dark |
| 3.1.3 | Click "System" | Theme matches OS prefer-color-scheme | Yes | PUT with `themeMode: null` | Reload: still follows OS |
| 3.1.4 | Click "Dark" then "Discard" | Preview reverts to committed value | Bar disappears | n/a | Reload: unchanged |

### 3.2 Density

| # | Action | Live preview | Save → reload |
|---|--------|--------------|---------------|
| 3.2.1 | Click "Compact" | Density preview block shrinks | PUT with `density: "COMPACT"`; reload: still compact |
| 3.2.2 | Click "Comfortable" | Default spacing | PUT 200; reload persists |
| 3.2.3 | Click "Spacious" | Block grows | PUT 200; reload persists |

### 3.3 Background

For BOTH dark and light cards:

| # | Action | Expected behavior | Reload behavior |
|---|--------|-------------------|------|
| 3.3.1 | Click "Click to upload" placeholder | File picker opens (jpg/png) | n/a |
| 3.3.2 | Select a JPG ≤5MB | **Blob URL preview** appears in card AND body background updates instantly; sticky bar appears | n/a (not saved yet) |
| 3.3.3 | Click Save | POST /api/v1/me/background (multipart) returns 200 with `url` | Reload: background image still there, served from /uploads/bg/{userId}-{mode}.jpg |
| 3.3.4 | Click "Replace" → choose new image → Save | Same flow; old file overwritten on disk | Reload: new image |
| 3.3.5 | Click "Remove" on a previously-saved bg | Card empties, body bg falls back to default; sticky bar appears | n/a |
| 3.3.6 | Click Save after Remove | DELETE /api/v1/me/background?mode={dark\|light} 204 | Reload: default background restored |
| 3.3.7 | Upload a PNG > 5MB | POST returns 400 | n/a |
| 3.3.8 | Upload a non-image (e.g. .pdf) | POST returns 400 | n/a |
| 3.3.9 | Select image → Discard (don't Save) | CSS var reverts; no file written on disk | Reload: previous bg still there |
| 3.3.10 | Select image → click sidebar Link (navigation guard) | Dialog: "Save changes?" with Stay/Discard/Save & leave | All 3 buttons behave correctly |

### 3.4 Layout — Sidebar Position

| # | Action | Live preview (if implemented) | Save → reload |
|---|--------|------|---------------|
| 3.4.1 | Click "Left" | Sidebar on left | PUT 200; reload persists |
| 3.4.2 | Click "Right" | (NOTE: live-preview may not be wired for sidebar pos — verify) | PUT 200; reload: sidebar on right |

### 3.5 Layout — Navigation Style

| # | Action | Save → reload |
|---|--------|---------------|
| 3.5.1 | Click "Tabs" | PUT 200; only tabs shown |
| 3.5.2 | Click "Breadcrumbs" | PUT 200; only breadcrumbs |
| 3.5.3 | Click "Both" | PUT 200; both visible |

### 3.6 Defaults

| # | Action | Save → reload |
|---|--------|---------------|
| 3.6.1 | Select "Agile" in methodology | PUT with `methodology: "agile"` |
| 3.6.2 | Select "Scrum"/"Kanban"/"Waterfall"/"Hybrid"/"SAFe" — each | Each PUTs the correct value |
| 3.6.3 | Type valid UUID in Default Board ID | PUT 200 |
| 3.6.4 | Clear Default Board ID | PUT with `defaultBoardId: null` |

### 3.7 Navigation guard

| # | Action | Expected |
|---|--------|----------|
| 3.7.1 | Make a change → click sidebar link to another page | "Save changes?" dialog with Stay / Discard / Save & leave |
| 3.7.2 | Same, but click "Stay" | Stays on preferences page, dirty state preserved |
| 3.7.3 | Same, but click "Discard" | Navigates away, draft thrown out, committed state restored |
| 3.7.4 | Same, but click "Save & leave" | PUT + uploads run, then navigates |
| 3.7.5 | Make a change → press Cmd+W (close tab) | Browser native "Leave site?" prompt |
| 3.7.6 | Make a change → reload page | Browser native prompt; on OK, changes discarded |
| 3.7.7 | No changes → click any link | Navigates without prompt |

---

## Section 4 — `/settings/themes`

| # | Control | Expected |
|---|---------|----------|
| 4.1 | "Create theme" button | Opens create-theme dialog |
| 4.2 | Submit new theme (name, mode LIGHT/DARK, base color) | POST /api/v1/orgs/:org/themes 201; row appears in list |
| 4.3 | "Activate" on a theme | POST /api/v1/orgs/:org/themes/:id/activate; theme tokens applied org-wide |
| 4.4 | "Edit" on an org-owned theme | PATCH /api/v1/orgs/:org/themes/:id; tokens update |
| 4.5 | "Delete" on an org-owned theme | DELETE 200; row gone (or confirm dialog if present) |
| 4.6 | "Edit" on a built-in theme | Should be read-only / "Clone to edit" |

---

## Section 5 — `/settings/custom-fields`

| # | Control | Action | Expected |
|---|---------|--------|----------|
| 5.1 | "Add Field" | Open dialog | Form appears with Name / Key / Type / Required |
| 5.2 | Submit TEXT | POST /custom-fields with `fieldType: "TEXT"` 201; row visible in table |
| 5.3 | Submit NUMBER | 201; row visible |
| 5.4 | Submit DATE | 201 |
| 5.5 | Submit SELECT (with options) | 201; options stored as array |
| 5.6 | Submit MULTI_SELECT | 201 |
| 5.7 | Submit CHECKBOX | 201 |
| 5.8 | Submit URL | 201 |
| 5.9 | Submit EMAIL | 201 |
| 5.10 | Submit USER | 201 |
| 5.11 | Required checkbox | Toggles `required` correctly |
| 5.12 | Edit field | PATCH 200; row updates |
| 5.13 | Delete field | DELETE 200 (or 409 if in use); row gone |
| 5.14 | Field appears on work item | Open any work-item dialog → custom fields section shows new field |

---

## Section 6 — `/settings/templates`

| # | Control | Expected |
|---|---------|----------|
| 6.1 | "Built-in" tab | 7 cards (Software, AEC, IT Ops, Consulting, Manufacturing, Education, Event Planning) |
| 6.2 | "Org templates" tab | Shows clones + empty state if none |
| 6.3 | Click "Clone" on a built-in | Dialog with name input → POST /project-templates/:id/clone 201; appears in Org tab |
| 6.4 | Click "Edit" on org template | Opens editor at `/[id]` |
| 6.5 | In editor: change name → Save | PATCH 200; gallery shows new name |
| 6.6 | In editor: toggle enabledFeatures checkbox | PATCH 200; persists |
| 6.7 | Click "Delete" on org template | Type-to-confirm dialog → DELETE 200; row gone |
| 6.8 | Click "Delete" on built-in | Disabled or hidden (403 if attempted via API) |

---

## Section 7 — `/settings/security`

This page may have multiple sub-sections: SSO, IP Allowlist, SCIM tokens, Active Sessions.

### 7.1 SSO config (if visible)
| # | Action | Expected |
|---|--------|----------|
| 7.1.1 | Toggle SSO on | PATCH /security/settings 200 |

### 7.2 IP Allowlist
| # | Action | Expected |
|---|--------|----------|
| 7.2.1 | Add IP entry "192.168.1.1" | POST /security/ip-allowlist 201; row appears |
| 7.2.2 | Add CIDR "10.0.0.0/8" | 201 |
| 7.2.3 | Delete an entry | DELETE 200; row gone |

### 7.3 SCIM tokens
| # | Action | Expected |
|---|--------|----------|
| 7.3.1 | "Generate token" | POST 201 returns token (shown once) |
| 7.3.2 | Revoke token | DELETE 200; row gone |

### 7.4 Active sessions
| # | Action | Expected |
|---|--------|----------|
| 7.4.1 | List your active sessions | GET 200; current session marked |
| 7.4.2 | "Revoke" another session | DELETE 200; that session row disappears |

---

## Section 8 — `/settings/compliance`

| # | Control | Expected |
|---|---------|----------|
| 8.1 | "Add Control" | Opens dialog |
| 8.2 | Submit new control (framework, control ID, status) | POST /compliance/controls 201 |
| 8.3 | Change status of control | PATCH 200 |
| 8.4 | Delete control | DELETE 200 |
| 8.5 | Summary cards | Reflect counts/percentages |

---

## Section 9 — `/settings/classifications`

| # | Control | Expected |
|---|---------|----------|
| 9.1 | "Add Classification" | Opens dialog |
| 9.2 | Submit (name, color, sortOrder) | POST 201; row appears |
| 9.3 | Edit | PATCH 200 |
| 9.4 | Delete | DELETE 200 |

---

## Section 10 — `/settings/integrations`

**Currently a stub** (BUG-26 deferred). Verify:
| # | Expected |
|---|----------|
| 10.1 | Page renders without errors |
| 10.2 | No interactive buttons (or clearly marked "Coming soon") |

---

## Section 11 — `/settings/webhooks`

| # | Control | Expected |
|---|---------|----------|
| 11.1 | "Create Webhook" | Dialog with URL + event checkboxes |
| 11.2 | Submit | POST 201; row in table |
| 11.3 | Click "Test" on a webhook | POST /webhooks/:id/test 200; recent delivery row appears |
| 11.4 | View "Deliveries" | GET 200; list of past attempts with status codes |
| 11.5 | Toggle webhook enabled | PATCH 200 |
| 11.6 | Delete webhook | DELETE 200 |

---

## Section 12 — `/settings/audit-logs`

| # | Control | Expected |
|---|---------|----------|
| 12.1 | Page loads with recent events | GET /audit-logs 200; rows visible |
| 12.2 | Date range filter | Network: GET with `?startDate=&endDate=` |
| 12.3 | Action filter | GET with `?action=` |
| 12.4 | User filter | GET with `?userId=` |
| 12.5 | "Export" button | GET /audit-logs/export 200; file download triggers |
| 12.6 | Pagination next/prev | GET with `?page=` |
| 12.7 | Click a row to expand | Shows metadata JSON |

---

## Section 13 — Cross-cutting checks (after all sections)

| # | Check | How |
|---|-------|-----|
| 13.1 | All settings respect dark/light mode | Toggle and visit each page |
| 13.2 | Mobile (375px wide) | Resize browser; each page is usable |
| 13.3 | Keyboard nav | Tab through each form; every control reachable + has focus ring |
| 13.4 | Required field validation | Empty submit on each form returns inline error (not 500) |
| 13.5 | Permission gating | Sign in as MEMBER; destructive actions should be hidden or 403 |
| 13.6 | URL deep-link to a settings sub-page | All 11 sub-pages load directly via URL (no redirect loop) |
| 13.7 | Browser back/forward | History works across settings sub-pages |
| 13.8 | Sidebar "Settings" link active state | Currently-viewed sub-page is highlighted |

---

## Section 14 — Negative paths / error handling

| # | Test | Expected |
|---|------|----------|
| 14.1 | Upload 6MB background | 400 with "File must be 5MB or smaller" |
| 14.2 | Upload .gif background | 400 with "File must be image/jpeg or image/png" |
| 14.3 | Type invalid UUID in defaultBoardId, Save | 400 from Zod; inline error or toast |
| 14.4 | Custom field with duplicate key | 409 |
| 14.5 | Theme name with 200+ chars | 400 |
| 14.6 | Webhook URL `not-a-url` | 400 |
| 14.7 | Delete a custom field that's in use on work items | 409 with helpful message |

---

## Section 15 — Test artifact cleanup

After this validation pass, remove the following:
- [ ] All test custom fields created
- [ ] Any test webhooks
- [ ] Any test classifications/compliance controls
- [ ] Any test themes (org-owned only; built-ins are protected)
- [ ] Any test IP allowlist entries
- [ ] Any test SCIM tokens
- [ ] Background images uploaded for the test pass (delete via Remove button)

---

## Final scorecard template

```
Section                                Pass/Total
─────────────────────────────────────────────────
1.  User menu                            X/5
2.  Profile                              X/4
3.  Preferences                          X/30
4.  Themes                               X/6
5.  Custom fields                        X/14
6.  Templates                            X/8
7.  Security                             X/8
8.  Compliance                           X/5
9.  Classifications                      X/4
10. Integrations                         X/2
11. Webhooks                             X/6
12. Audit logs                           X/7
13. Cross-cutting                        X/8
14. Negative paths                       X/7
─────────────────────────────────────────────────
TOTAL                                    X/114
```
