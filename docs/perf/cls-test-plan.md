# CLS residual — manual test plan (real browser)

The automated `e2e/perf-vitals.spec.ts` **logs** CLS per page but does **not gate**
on it: headless Chromium uses 0px overlay scrollbars, so the residual layout
shift (a ~7px horizontal reflow that looks like a classic scrollbar appearing as
content overflows) **cannot be faithfully reproduced or verified headless**.
This plan is how to measure + fix it in a real browser with classic scrollbars.

Known residual (from `[perf]` logs + Round 22/25 work): **finance ~1.07**,
plus integrations / compliance / notes / audit-logs in the 0.3–1.0 range.
analytics/templates/board/crm/most pages are already good (~0.03).

## 0. Environment (do this once)

CLS depends on prod build + classic scrollbars + realistic data — none of which
the dev server or headless CI reflect.

1. **Build + serve prod** (NOT `next dev` — dev ≠ prod):
   ```bash
   npm run build
   E2E_TEST_AUTH=1 PORT=3200 npm run start
   ```
2. **Use a real, visible Chrome** (not headless) with **classic scrollbars**:
   - macOS: System Settings → Appearance → "Show scroll bars: Always".
   - Or test on Windows/Linux Chrome, which default to classic overlay-less bars.
   - This is the whole point: the shift is a scrollbar appearing; overlay
     scrollbars (headless / macOS default) hide it.
3. **Realistic data**: sign in to an org that actually has finance/notes/etc.
   data (the empty test-org makes content sparse and changes the shift). Use a
   real seeded org or your working org. Sign in via Google as normal, or run
   against `test-org` after seeding more rows.

## 1. Measure the baseline (per suspect page)

For each of finance, integrations, compliance, notes, audit-logs:

**Option A — Lighthouse (preferred, gives the number + the elements):**
- DevTools → Lighthouse → Mode: Navigation, Device: Desktop → Analyze.
- Read **Cumulative Layout Shift**. Expand "Avoid large layout shifts" → it
  lists the exact shifting elements.

**Option B — live web-vitals in the console:**
```js
// paste in DevTools console, then hard-reload the page
let cls = 0;
new PerformanceObserver((l) => {
  for (const e of l.getEntries()) if (!e.hadRecentInput) {
    cls += e.value;
    console.log("shift", e.value.toFixed(4), [...e.sources].map(s => s.node));
  }
}).observe({ type: "layout-shift", buffered: true });
addEventListener("visibilitychange", () => console.log("CLS total", cls.toFixed(4)));
```
The `s.node` values are the **actual DOM nodes that moved** — note them.

**Option C — DevTools Performance panel:** record a reload; in the timeline,
"Layout Shift" markers show the shifted region (red rectangle) — confirm whether
the whole content column shifts left/narrows (the scrollbar hypothesis) vs. a
specific block (a skeleton→content collapse).

## 2. Confirm the mechanism

The R25 diagnosis was: during load the content column's left edge moves +~7px and
its width shrinks ~7px — i.e. a **vertical scrollbar appears** once content
overflows the viewport, narrowing the layout. Confirm which scroller it is:

- In DevTools, find which element actually scrolls the page. The shell is
  `div.flex.h-screen.overflow-hidden` (dashboard-shell.tsx) with the content in
  `<main id="main" class="... overflow-y-auto">`. So `main` *should* be the
  scroller, not the window.
- Check: does the **window** (documentElement/body) get a scrollbar on these
  pages, or does `main`? If the window scrolls (despite the `h-screen
  overflow-hidden` shell), that's the bug — content is escaping the intended
  inner scroller.
- Watch the reflow: throttle network (Slow 3G) + reload; observe whether the
  jump coincides with the scrollbar appearing.

## 3. Candidate fixes (apply one, re-measure, revert if no effect)

In order of likelihood:

1. **`scrollbar-gutter: stable` on the true scroller.** If `main` is the
   scroller, add it there; if the window scrolls, add it to `html`/`body`.
   (R25 tried `main`/shell/`html` headless with no effect — but headless can't
   show the gutter, so **re-test this in a real browser first**; it's the most
   likely real fix.) File: `src/components/layouts/dashboard-shell.tsx` (`<main>`)
   or `src/app/globals.css` (`html`/`body`).
2. **Reserve the scrollbar from the start**: `html { overflow-y: scroll; }` so a
   gutter is always present (no appear-on-overflow jump). Trade-off: always shows
   a track even on short pages.
3. **Fix the escaping scroller**: if the window scrolls despite the shell being
   `h-screen overflow-hidden`, find what breaks the inner `main` scroll
   containment on these specific pages (a child with `min-height`/large content
   that pushes the shell taller than the viewport) and constrain it.
4. **Skeleton→content collapse** (secondary): if the Performance panel shows a
   *specific block* shifting (not the whole column), the page's loading skeleton
   differs in height from the loaded content — apply the R22 minimal-skeleton
   pattern (toolbar row + one `<Skeleton className="h-64 rounded-lg"/>`, no
   phantom title) so content grows downward. Reference good pages:
   webhooks-manager, classification-manager.

## 4. Verify

- Re-run Lighthouse / the web-vitals snippet on the same page; target **CLS <
  0.1** (ideally < 0.05).
- Check it didn't regress other pages (the gutter/overflow change is global).
- Optionally capture before/after numbers from the CI `[perf]` logs for a record
  (note those are headless, so absolute values differ — use them only for
  relative regression tracking, not the pass/fail bar).

## 5. If you fix it

- Land the CSS change as a normal round (it IS a user-visible change → bump
  version). Update `memory/perf-cls.md` to move the residual from "backlog" to
  "fixed" with the before/after.
- Consider tightening `perf-vitals.spec.ts` to also assert CLS once a real
  browser confirms the headless number is stable enough to gate on (it may not
  be — document if so).
