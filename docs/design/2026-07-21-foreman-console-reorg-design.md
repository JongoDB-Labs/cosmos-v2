# Foreman Console Reorganization — Design

**Status:** Approved design (brainstorm 2026-07-21). Ready for implementation plan.
**Goal:** Turn the Foreman console from a flat vertical stack of ~13 panels into a tabbed, intuitively-navigated subsystem, and collapse the redundant Skills create/import forms into one "Add skill" flow — without removing any functionality.

## 1. Architecture

`src/components/foreman/foreman-console.tsx` gains a **tabbed shell**. The global **status header** (pulse pill + Pause/Resume control) stays *above* the tabs — it applies to all views. Below it, a **tab bar** switches between four content groups. Panels are **moved, not modified** (they self-fetch via react-query), so regrouping is pure layout with no per-panel logic change.

### 1.1 Tab component
No Tabs primitive exists in `src/components/ui/`. Build a **lightweight, accessible tab bar** — no new dependency:
- A `ConsoleTabs` helper (in `foreman-console.tsx` or a small `console-tabs.tsx`): renders a `role="tablist"` row of `<button role="tab" aria-selected>` items and shows the active `role="tabpanel"`.
- Active tab is derived from the URL `?tab=` search param (`useSearchParams`), defaulting to `"activity"`. Clicking a tab calls `router.replace(?tab=<id>)` (shallow) so tabs are **deep-linkable + back-button friendly**. Unknown/absent `?tab` → `activity`.
- Keyboard: Left/Right arrow moves between tabs (roving tabindex); Enter/Space activates. Each panel `aria-labelledby` its tab.
- Tab labels: **Activity · Connections · Build behavior · Automation**.

### 1.2 Tab taxonomy (what goes where)
| Tab | Panels (existing components, moved in) |
|---|---|
| **Activity** (default) | status is the header above; then: "Up next" · "In flight" · "Awaiting approval" · "Coordinated releases" · `ForemanLoopMetricsPanel` (Delivery convergence) · `ForemanGroomingFeed` (Supervisor activity) · `ForemanEventFeed`. The contextual Requirements-analysis / Intake-decisions surfaces stay where they render today (inside the approval/intake flow). |
| **Connections** | `ForemanClaudePanel` · `ForemanGithubPanel` |
| **Build behavior** | `ForemanHarnessPanel` · `ForemanSkillsPanel` · `ForemanMcpPanel` |
| **Automation** | `ForemanSupervisorPanel` |

No panel is dropped. The only components touched are `foreman-console.tsx` (layout) and `foreman-skills-panel.tsx` (de-dup, §2).

## 2. Skills de-duplication (`foreman-skills-panel.tsx`)

Today the panel has two separate sub-forms: **create** (`createName`/`createDescription`/`createBody` fields) and **import** (`importBody` — paste a SKILL.md). Collapse to **one "Add skill" card + a Compose | Paste mode toggle**:

- **Compose** (default) — the guided `name` / `description` / `body` fields (today's create).
- **Paste** — a single textarea "Paste a SKILL.md". On "Fill from paste" (or on the Add action in Paste mode), call the existing pure `parseSkillMarkdown(md)` (`src/lib/foreman/skill-import.ts`, already client-importable) to populate the **same** `name`/`description`/`body` fields, switch to the Compose view showing the parsed values (**editable — review before save**), and clear the paste box. If `parseSkillMarkdown` throws (no name), show its message inline and don't switch.
- Both modes converge on a **single "Add skill" submit** → the existing **create** path (`POST .../foreman/skills`). Client-side parsing means Paste no longer needs the separate import endpoint.
- Remove the separate import form + `importBody`/`importing` state. The import API route becomes unused by the console — leave it in place (out of scope to delete; harmless), noted for a future cleanup.

Net: one form, one submit path, and pasted skills gain a review-before-save they lacked.

## 3. Fold-in: console-test regression fix

`ForemanLoopMetricsPanel` (Phase 4) self-fetches `/foreman/loop-metrics`; `foreman-console.test.tsx` had no mock, so it hit the status-shaped fallback and crashed 7 sibling tests (shipped in v2.221.0 past an `--admin` merge). The rewritten console test (§4) MUST mock `/foreman/loop-metrics` (0-loop payload → panel renders null). This repairs `check` on main.

## 4. Testing

- **Console (`foreman-console.test.tsx`):** the existing behavior tests ("awaiting approval", "Rework dialog", status pill, AI-analysis) all exercise panels now under the **Activity** tab, which is the **default** — so they keep working once the loop-metrics mock is added. ADD: (a) the four tab buttons render with correct labels + `role="tab"`; (b) `?tab=connections` (etc.) selects that tab and shows its panels; (c) default (no `?tab`) shows Activity; (d) clicking a tab updates the URL. Mock `/foreman/loop-metrics` (§3).
- **Skills (`foreman-skills-panel.test.tsx`):** (a) Compose fills fields → Add → POSTs create with name/description/body; (b) Paste a valid SKILL.md → fields populate from `parseSkillMarkdown` → Add → POSTs create; (c) Paste an invalid SKILL.md (no name) → inline error, no submit; (d) the old separate import form is gone.
- No new e2e required. `parseSkillMarkdown` already has unit tests (`skill-import.test.ts`).

## 5. Out of scope (noted)

- The loop `off/shadow/live` control has **no UI yet**; **Automation** is its natural future home, but building it is not part of this change.
- Deleting the now-unused skills import API route (leave for a future cleanup).
- No visual restyle of the panels themselves — only grouping + the skills form.

## 6. Risks

- **Existing console tests relying on all panels rendering at once** → mitigated: they use Activity-tab panels + Activity is default; only cross-tab tests need a tab switch (added explicitly).
- **URL `?tab` sync causing a render loop** → use `router.replace` + derive state from the param (single source of truth), don't mirror into local state.
- **Skills parse errors** → surfaced inline via the existing `notifyError`/toast pattern; Paste never silently drops content.
