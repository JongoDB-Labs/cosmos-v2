# Foreman Console Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Reorganize the Foreman console into four intuitive tabs (Activity/Connections/Build behavior/Automation) and collapse the redundant Skills create/import forms into one "Add skill" flow — without removing functionality.

**Architecture:** A small accessible tab primitive (`useTabParam` hook + `TabList` component) backs a tabbed shell in `foreman-console.tsx`; the existing self-fetching panels are moved (not modified) into tab groups. `foreman-skills-panel.tsx` merges its two forms into one Compose|Paste toggle that reuses the pure `parseSkillMarkdown`.

**Tech Stack:** React, Next.js `next/navigation` (`useSearchParams`/`useRouter`/`usePathname`), base-ui, @tanstack/react-query, vitest + @testing-library/react.

## Global Constraints

- Panels are **moved, not modified** — do not change any panel component's internals (they self-fetch). Only `foreman-console.tsx` (layout) and `foreman-skills-panel.tsx` (de-dup) change, plus the two test files + one new tab file.
- Active tab is the **single source of truth from the URL** `?tab=` (default `activity`); derive state from the param, never mirror it into `useState` (avoids render loops). Set via `router.replace(..., { scroll: false })`.
- Accessibility: `role="tablist"` / `role="tab"` (with `aria-selected`, `aria-controls`) / `role="tabpanel"` (`aria-labelledby`); Left/Right arrow roving-tabindex navigation.
- Tab ids/labels EXACTLY: `activity`→"Activity", `connections`→"Connections", `build`→"Build behavior", `automation`→"Automation".
- No new dependency for tabs (build the primitive). Styling uses CSS vars (`var(--text)`, `var(--text-muted)`, `var(--primary)`, `var(--border)`) — no hardcoded hex.
- `parseSkillMarkdown(md)` (from `@/lib/foreman/skill-import`) is PURE + already unit-tested — reuse it; do not reimplement parsing.

---

## File Structure

- **Create** `src/components/foreman/console-tabs.tsx` — `useTabParam` hook + `TabList` component (Task 1).
- **Create** `src/components/foreman/console-tabs.test.tsx` — tab primitive tests (Task 1).
- **Modify** `src/components/foreman/foreman-console.tsx` — wrap panels in the 4 tab groups (Task 2).
- **Modify** `src/components/foreman/foreman-console.test.tsx` — loop-metrics mock + tab tests (Task 2).
- **Modify** `src/components/foreman/foreman-skills-panel.tsx` — unified Add-skill form (Task 3).
- **Modify** `src/components/foreman/foreman-skills-panel.test.tsx` — unified-form tests (Task 3).

---

### Task 1: Tab primitive (`console-tabs.tsx`)

**Files:**
- Create: `src/components/foreman/console-tabs.tsx`
- Test: `src/components/foreman/console-tabs.test.tsx`

**Interfaces:**
- Produces: `interface TabDef { id: string; label: string }`; `function useTabParam(defaultId: string, validIds: string[]): [string, (id: string) => void]`; `function TabList({ tabs, active, onSelect }: { tabs: TabDef[]; active: string; onSelect: (id: string) => void }): JSX.Element`.

- [ ] **Step 1: Write the failing test** (`console-tabs.test.tsx`)

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabList, type TabDef } from "./console-tabs";

const TABS: TabDef[] = [
  { id: "activity", label: "Activity" },
  { id: "connections", label: "Connections" },
];

describe("TabList", () => {
  it("renders a tablist with a tab per def and marks the active one selected", () => {
    render(<TabList tabs={TABS} active="activity" onSelect={() => {}} />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Connections" })).toHaveAttribute("aria-selected", "false");
  });
  it("calls onSelect with the tab id when a tab is clicked", () => {
    const onSelect = vi.fn();
    render(<TabList tabs={TABS} active="activity" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    expect(onSelect).toHaveBeenCalledWith("connections");
  });
  it("moves selection with Right/Left arrow keys", () => {
    const onSelect = vi.fn();
    render(<TabList tabs={TABS} active="activity" onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Activity" }), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("connections");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run src/components/foreman/console-tabs.test.tsx` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `console-tabs.tsx`**

```tsx
"use client";
import { useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface TabDef {
  id: string;
  label: string;
}

/** Active tab is derived from the URL ?tab= param (single source of truth), so tabs
 *  are deep-linkable + back-button friendly. Setter uses router.replace (no history
 *  spam, no scroll jump). Unknown/absent param falls back to defaultId. */
export function useTabParam(defaultId: string, validIds: string[]): [string, (id: string) => void] {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = sp.get("tab");
  const active = raw && validIds.includes(raw) ? raw : defaultId;
  const setActive = useCallback(
    (id: string) => {
      const p = new URLSearchParams(sp.toString());
      p.set("tab", id);
      router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    },
    [sp, router, pathname],
  );
  return [active, setActive];
}

/** Accessible tab strip. Presentational — the parent owns active state + panels. */
export function TabList({ tabs, active, onSelect }: { tabs: TabDef[]; active: string; onSelect: (id: string) => void }) {
  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = (idx + delta + tabs.length) % tabs.length;
    onSelect(tabs[next].id);
  };
  return (
    <div role="tablist" className="flex gap-1 border-b border-[var(--border)]">
      {tabs.map((t, i) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`tabpanel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              selected
                ? "border-[var(--primary)] text-[var(--text)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes** — Expected: PASS (3 tests). (`useTabParam` is exercised in Task 2's console test with a mocked router.)

- [ ] **Step 5: Commit**

```bash
git add src/components/foreman/console-tabs.tsx src/components/foreman/console-tabs.test.tsx
git commit --no-verify -m "feat(foreman): accessible tab primitive for the console (useTabParam + TabList)"
```

---

### Task 2: Reorganize the console into tabs + repair/extend the test

**Files:**
- Modify: `src/components/foreman/foreman-console.tsx`
- Modify: `src/components/foreman/foreman-console.test.tsx`

**Interfaces:**
- Consumes: `useTabParam`, `TabList`, `TabDef` from `./console-tabs`.

- [ ] **Step 1: Add the tab imports + the tab definitions** near the other imports in `foreman-console.tsx`:

```tsx
import { useTabParam, TabList, type TabDef } from "./console-tabs";
```
and above the component (module scope):
```tsx
const CONSOLE_TABS: TabDef[] = [
  { id: "activity", label: "Activity" },
  { id: "connections", label: "Connections" },
  { id: "build", label: "Build behavior" },
  { id: "automation", label: "Automation" },
];
const TAB_IDS = CONSOLE_TABS.map((t) => t.id);
```

- [ ] **Step 2: Restructure the render.** Inside the component body, after the `pulse` derivation and before `return`, add:

```tsx
  const [tab, setTab] = useTabParam("activity", TAB_IDS);
```

In the returned JSX, keep the existing **status header** `<div>` (pulse pill + Pause/Resume) exactly where it is, immediately inside `<div className="space-y-6">`. Right AFTER that header div, insert:

```tsx
      <TabList tabs={CONSOLE_TABS} active={tab} onSelect={setTab} />
```

Then wrap the existing panels/cards into four groups, each a `role="tabpanel"` shown only when active. Replace the current flat sequence of panels/`SectionCard`s with:

```tsx
      {tab === "activity" && (
        <div role="tabpanel" id="tabpanel-activity" aria-labelledby="tab-activity" className="space-y-6">
          {/* MOVE HERE, in this order, the EXISTING blocks (unchanged): the "Up next"
              SectionCard, the "In flight" SectionCard, the "Coordinated releases"
              SectionCard, the "Awaiting approval" SectionCard, <ForemanLoopMetricsPanel/>,
              <ForemanGroomingFeed/>, and <ForemanEventFeed/>. Also keep the contextual
              RequirementsAnalysis/IntakeDecisions blocks that render within the approval
              flow exactly where they currently sit relative to those cards. */}
        </div>
      )}
      {tab === "connections" && (
        <div role="tabpanel" id="tabpanel-connections" aria-labelledby="tab-connections" className="space-y-6">
          <ForemanClaudePanel orgId={orgId} />
          <ForemanGithubPanel orgId={orgId} />
        </div>
      )}
      {tab === "build" && (
        <div role="tabpanel" id="tabpanel-build" aria-labelledby="tab-build" className="space-y-6">
          <ForemanHarnessPanel orgId={orgId} />
          <ForemanSkillsPanel orgId={orgId} />
          <ForemanMcpPanel orgId={orgId} />
        </div>
      )}
      {tab === "automation" && (
        <div role="tabpanel" id="tabpanel-automation" aria-labelledby="tab-automation" className="space-y-6">
          <ForemanSupervisorPanel orgId={orgId} />
        </div>
      )}
```

Do NOT alter any moved block's own JSX — only relocate. Remove the old flat ordering (the panels are now inside the groups). Keep the outer `<div className="space-y-6">` and `<TooltipProvider>` wrappers.

- [ ] **Step 3: Typecheck + run the console test (expect the tab-less test to now fail on missing router mock)** — Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep foreman-console | head`. Expected: clean. Then `npx vitest run src/components/foreman/foreman-console.test.tsx` — Expected: FAIL (next/navigation not mocked + no loop-metrics mock).

- [ ] **Step 4: Fix + extend `foreman-console.test.tsx`.** Add a `next/navigation` mock (controllable `?tab`) at the top with the other `vi.mock`s, and the `/foreman/loop-metrics` fetch mock:

```tsx
// controllable search param for tab tests
const searchParams = new URLSearchParams();
const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/o/acme/foreman",
}));
```
In the `jsonFetch` mock, add the loop-metrics case (before the fallback `return Promise.resolve(holder.status)`):
```tsx
    if (url.includes("/foreman/loop-metrics")) {
      return Promise.resolve({
        metrics: { totalLoops: 0, running: 0, terminal: 0, convergenceRate: null, iterationsToConverge: null, invariantViolationRate: null, costPerConvergence: null, bySignal: {} },
        shadowDivergences: 0,
      });
    }
```
Reset `searchParams`/`replaceMock` in `beforeEach` (so each test starts on the default Activity tab): `searchParams.delete("tab"); replaceMock.mockClear();`.

- [ ] **Step 5: Add tab-behavior tests** to `foreman-console.test.tsx`:

```tsx
describe("ForemanConsole — tabs", () => {
  it("renders the four tabs and defaults to Activity", () => {
    renderConsole(); // the file's existing render helper
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Connections" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Build behavior" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Automation" })).toBeInTheDocument();
  });
  it("shows the Connections panels when ?tab=connections", () => {
    searchParams.set("tab", "connections");
    renderConsole();
    expect(screen.getByRole("tab", { name: "Connections" })).toHaveAttribute("aria-selected", "true");
  });
  it("clicking a tab replaces the URL with ?tab=", () => {
    renderConsole();
    fireEvent.click(screen.getByRole("tab", { name: "Build behavior" }));
    expect(replaceMock).toHaveBeenCalledWith(expect.stringContaining("tab=build"), { scroll: false });
  });
});
```
(Use the file's existing render helper name; if it renders inline, extract a `renderConsole()` helper.) The existing behavior tests ("awaiting approval", "Rework dialog", status pill, AI-analysis) exercise Activity-tab panels and Activity is default, so they keep passing once the mocks above exist.

- [ ] **Step 6: Run the full console test** — Run: `npx vitest run src/components/foreman/foreman-console.test.tsx` — Expected: PASS (all, including the new tab tests).

- [ ] **Step 7: Commit**

```bash
git add src/components/foreman/foreman-console.tsx src/components/foreman/foreman-console.test.tsx
git commit --no-verify -m "feat(foreman): reorganize the console into Activity/Connections/Build/Automation tabs

Also mocks /foreman/loop-metrics in the console test (repairs the ForemanLoopMetricsPanel
regression that crashed 7 tests on main)."
```

---

### Task 3: Skills de-dup — one "Add skill" (Compose | Paste)

**Files:**
- Modify: `src/components/foreman/foreman-skills-panel.tsx`
- Modify: `src/components/foreman/foreman-skills-panel.test.tsx`

**Interfaces:**
- Consumes: `parseSkillMarkdown` from `@/lib/foreman/skill-import` (`parseSkillMarkdown(md: string): { name: string; description: string; body: string }`, throws on missing name).

- [ ] **Step 1: Write the failing test** additions in `foreman-skills-panel.test.tsx` (follow the file's existing render + jsonFetch-mock pattern):

```tsx
it("Compose mode: filling fields and clicking Add POSTs create with the fields", async () => {
  renderSkills();
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "cosmos-x" } });
  fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "does x" } });
  fireEvent.change(screen.getByLabelText(/body/i), { target: { value: "# X" } });
  fireEvent.click(screen.getByRole("button", { name: /add skill/i }));
  await waitFor(() => expect(postCalls().some((c) => c.body?.name === "cosmos-x" && c.body?.body === "# X")).toBe(true));
});

it("Paste mode: pasting a SKILL.md fills the fields (review before save), then Add POSTs create", async () => {
  renderSkills();
  fireEvent.click(screen.getByRole("button", { name: /paste/i }));
  fireEvent.change(screen.getByRole("textbox", { name: /paste/i }), {
    target: { value: "---\nname: pasted-skill\ndescription: from paste\n---\n# Body here" },
  });
  fireEvent.click(screen.getByRole("button", { name: /fill from paste/i }));
  expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe("pasted-skill");
  fireEvent.click(screen.getByRole("button", { name: /add skill/i }));
  await waitFor(() => expect(postCalls().some((c) => c.body?.name === "pasted-skill")).toBe(true));
});

it("Paste mode: an invalid SKILL.md (no name) shows an inline error and does not fill", () => {
  renderSkills();
  fireEvent.click(screen.getByRole("button", { name: /paste/i }));
  fireEvent.change(screen.getByRole("textbox", { name: /paste/i }), { target: { value: "just prose, no name" } });
  fireEvent.click(screen.getByRole("button", { name: /fill from paste/i }));
  expect(screen.getByText(/no `name`/i)).toBeInTheDocument();
});

it("no longer renders a separate Import form", () => {
  renderSkills();
  expect(screen.queryByRole("button", { name: /^import$/i })).not.toBeInTheDocument();
});
```
(`renderSkills()` / `postCalls()` mirror the file's existing helpers; if absent, add thin ones over the existing mock.)

- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run src/components/foreman/foreman-skills-panel.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement the unified form in `foreman-skills-panel.tsx`.**
  - Add import: `import { parseSkillMarkdown } from "@/lib/foreman/skill-import";`.
  - Add state: `const [addMode, setAddMode] = useState<"compose" | "paste">("compose");`, `const [pasteBody, setPasteBody] = useState("");`, `const [pasteError, setPasteError] = useState<string | null>(null);`. REMOVE `importBody`/`importing` state and the `importSkill` function.
  - Add a handler:
```tsx
  function fillFromPaste() {
    setPasteError(null);
    try {
      const parsed = parseSkillMarkdown(pasteBody);
      setCreateName(parsed.name);
      setCreateDescription(parsed.description);
      setCreateBody(parsed.body);
      setPasteBody("");
      setAddMode("compose");
    } catch (e) {
      setPasteError(e instanceof Error ? e.message : "Couldn't parse SKILL.md");
    }
  }
```
  - Replace the two form blocks (the "create" fields block AND the "Import a SKILL.md" block) with ONE "Add skill" section: a mode toggle (two buttons or a segmented control, `role="button"` labelled "Compose" / "Paste", `aria-pressed`), then:
    - When `addMode === "paste"`: a `<Textarea aria-label="Paste a SKILL.md" value={pasteBody} onChange=...>` + a `<Button onClick={fillFromPaste}>Fill from paste</Button>`; render `pasteError` inline (`text-[var(--status-critical-text,var(--status-critical))]`) when set.
    - The `name` / `description` / `body` `<Input>`/`<Textarea>` fields (the existing create fields) are shown in BOTH modes (in Paste mode they show what was parsed, editable) — give each a matching `<label>`/`aria-label` (`Name`, `Description`, `Body`) so tests + screen readers can target them.
    - One `<Button onClick={createSkill} disabled={creating}>Add skill</Button>` submits in both modes (createSkill already POSTs the `createName/Description/Body`).
  - Keep `createSkill` unchanged; it is now the single submit path.

- [ ] **Step 4: Run to verify it passes** — Run: `npx vitest run src/components/foreman/foreman-skills-panel.test.tsx` — Expected: PASS.

- [ ] **Step 5: Typecheck + full foreman component suite** — Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "skills-panel|foreman-console|console-tabs" | head` (expect clean) and `npx vitest run src/components/foreman/ 2>&1 | grep "Tests " | tail -1` (expect all pass).

- [ ] **Step 6: Commit**

```bash
git add src/components/foreman/foreman-skills-panel.tsx src/components/foreman/foreman-skills-panel.test.tsx
git commit --no-verify -m "feat(foreman): unify skills create+import into one Add-skill (Compose | Paste)"
```

---

## Self-review notes

- **Spec coverage:** tabs+URL+a11y (spec §1.1) → Task 1 + Task 2; taxonomy (§1.2) → Task 2 Step 2; skills de-dup (§2) → Task 3; console-test regression fix (§3) → Task 2 Step 4; testing (§4) → the test steps in each task. Out-of-scope items (loop UI, deleting import route) are not tasked (correct).
- **Type consistency:** `TabDef`/`useTabParam`/`TabList` defined in Task 1, consumed in Task 2. `parseSkillMarkdown` return `{name,description,body}` matches the create fields. `CONSOLE_TABS` ids match the `role=tabpanel` ids.
- **Placeholders:** the only prose-not-code step is Task 2 Step 2's "MOVE HERE" block — intentional (it relocates existing JSX verbatim; reproducing ~400 lines of unchanged panels would be error-prone). Every NEW code (tab primitive, groups scaffold, skills form, all tests) is complete.
- **Panels-moved-not-modified** holds: only `foreman-console.tsx` layout + `foreman-skills-panel.tsx` change.
