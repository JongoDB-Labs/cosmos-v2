#!/usr/bin/env node
/**
 * Drives the v3.5.1 layout-fix acceptance criteria against the running
 * cosmos-app at http://127.0.0.1:3000. Requires a fresh session id minted
 * by scripts/create-dev-session.mjs to be passed via SESSION_ID env var.
 *
 * Usage:
 *   SESSION_ID=<uuid> ORG_SLUG=fsc node --env-file=.env.local \
 *     scripts/verify-layout-fix.mjs
 *
 * Prints a JSON report to stdout describing each AC pass/fail.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const SESSION_ID = process.env.SESSION_ID;
const ORG_SLUG = process.env.ORG_SLUG ?? "fsc";

if (!SESSION_ID) {
  console.error("SESSION_ID env var required");
  process.exit(2);
}

const report = { base: BASE, orgSlug: ORG_SLUG, criteria: {} };

function record(key, pass, detail) {
  report.criteria[key] = { pass, ...detail };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  await context.addCookies([{
    name: "session",
    value: SESSION_ID,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  }]);

  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));

  // The dashboard layout streams via Suspense: the fallback skeleton renders
  // its own <main> (without overflow-x-hidden) before the real shell arrives.
  // This helper navigates and then waits until the streamed shell wins.
  async function gotoShell(url, { waitTall = false } = {}) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => {
        const m = document.querySelector("main");
        return !!m && /overflow-x-hidden/.test(m.className || "");
      },
      { timeout: 15_000 },
    );
    if (waitTall) {
      // Wait for content to stream in such that the page is scrollable.
      await page.waitForFunction(
        () => {
          const m = document.querySelector("main");
          return !!m && m.scrollHeight > m.clientHeight + 50;
        },
        { timeout: 10_000 },
      ).catch(() => {});
    }
    await sleep(400);
  }

  // ============= AC1: scroll restoration =============
  // /settings/preferences renders a tall form (~3500px scrollHeight) so the
  // page is guaranteed scrollable. Audit-logs may be empty on a fresh dev
  // DB, which would short-circuit the test to a trivial 0→0 pass.
  try {
    await gotoShell(`${BASE}/${ORG_SLUG}/settings/preferences`, { waitTall: true });
    // Use a real user-initiated wheel scroll so the hook's user-input
    // listeners fire and the save lands in scrollMap.
    const mainBox = await page.$eval("main", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(mainBox.x, mainBox.y);
    // Scroll in increments so the browser handles each wheel event distinctly.
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, 90);
      await sleep(50);
    }
    await sleep(300);
    const beforeScroll = await page.$eval("main", (el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    // Use raw .click() via evaluate. Playwright's page.click() synthesizes
    // pointer events through an internal pipeline that — for reasons I
    // haven't fully traced — causes Next.js to begin its route transition
    // before our pointerdown handler fires, by which point content has
    // already been swapped and main.scrollHeight has shrunk.
    async function navClick(href) {
      await page.evaluate((sel) => {
        const a = document.querySelector(sel);
        if (a) a.click();
      }, `a[href="${href}"]`);
    }
    if (beforeScroll.scrollHeight <= beforeScroll.clientHeight) {
      throw new Error(`AC1 test page not scrollable: scrollHeight=${beforeScroll.scrollHeight} clientHeight=${beforeScroll.clientHeight}`);
    }
    // Client-side navigation away — pick a path that has its own (different) content
    await navClick(`/${ORG_SLUG}/settings/audit-logs`);
    await page.waitForURL(`**/${ORG_SLUG}/settings/audit-logs`, { timeout: 5000 }).catch(() => {});
    await sleep(500);
    // Confirm the new page reset to top — the restorer should put it at 0
    // because preferences' saved scroll is for the OTHER path.
    const intermediateScroll = await page.$eval("main", (el) => el.scrollTop);
    // Navigate back to preferences
    await navClick(`/${ORG_SLUG}/settings/preferences`);
    await page.waitForURL(`**/${ORG_SLUG}/settings/preferences`, { timeout: 5000 }).catch(() => {});
    await sleep(500);
    const afterScroll = await page.$eval("main", (el) => el.scrollTop);
    const restored = Math.abs(afterScroll - beforeScroll.scrollTop) < 30;
    record("AC1_scroll_restoration", restored, {
      beforeScrollTop: beforeScroll.scrollTop,
      intermediateScrollTop: intermediateScroll,
      afterScrollTop: afterScroll,
      mainScrollable: beforeScroll.scrollHeight > beforeScroll.clientHeight,
    });
  } catch (e) {
    record("AC1_scroll_restoration", false, { error: String(e).slice(0, 200) });
  }

  // ============= AC2: hash anchor scrolls main =============
  try {
    await gotoShell(`${BASE}/${ORG_SLUG}/settings/preferences`);
    // Inject a target element near the bottom of main
    const inject = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) return { ok: false };
      const target = document.createElement("div");
      target.id = "ac2-test-target";
      target.style.cssText = "height:1px;width:1px;";
      target.textContent = "ac2-target";
      // Push the spacer well below the fold so scrolling is required
      const spacer = document.createElement("div");
      spacer.style.cssText = "height:2000px;";
      spacer.id = "ac2-spacer";
      main.appendChild(spacer);
      main.appendChild(target);
      return { ok: true, mainScrollHeight: main.scrollHeight };
    });
    main_scroll_before: {
      var before = await page.$eval("main", (el) => el.scrollTop);
    }
    await page.evaluate(() => {
      window.location.hash = "#ac2-test-target";
    });
    await sleep(700); // give the smooth scroll time to complete
    const result = await page.evaluate(() => {
      const main = document.querySelector("main");
      const target = document.getElementById("ac2-test-target");
      if (!main || !target) return { mainScroll: null };
      const mainRect = main.getBoundingClientRect();
      const tRect = target.getBoundingClientRect();
      const isVisible =
        tRect.top >= mainRect.top &&
        tRect.bottom <= mainRect.bottom + 4;
      return {
        mainScroll: main.scrollTop,
        windowScroll: window.scrollY,
        targetInMainViewport: isVisible,
        targetTopMinusMainTop: tRect.top - mainRect.top,
      };
    });
    record("AC2_hash_anchor_scrolls_main", inject.ok && result.mainScroll > 0 && result.targetInMainViewport, {
      injected: inject,
      beforeScroll: before,
      afterScroll: result,
    });
  } catch (e) {
    record("AC2_hash_anchor_scrolls_main", false, { error: String(e).slice(0, 200) });
  }

  // ============= AC3: no nested horizontal scrollbars =============
  try {
    await gotoShell(`${BASE}/${ORG_SLUG}/settings/audit-logs`);
    const overflowState = await page.evaluate(() => {
      const main = document.querySelector("main");
      const mainStyle = main ? getComputedStyle(main) : null;
      // Look for any nested element inside main that has overflow-x: auto/scroll
      const nestedScrollers = [];
      if (main) {
        const all = main.querySelectorAll("*");
        for (const el of all) {
          const s = getComputedStyle(el);
          if ((s.overflowX === "auto" || s.overflowX === "scroll") && el.scrollWidth > el.clientWidth) {
            nestedScrollers.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className || "").toString().slice(0, 60),
              overflowX: s.overflowX,
              scrollWidth: el.scrollWidth,
              clientWidth: el.clientWidth,
            });
          }
        }
      }
      return {
        mainOverflowX: mainStyle?.overflowX,
        mainScrollWidth: main?.scrollWidth ?? null,
        mainClientWidth: main?.clientWidth ?? null,
        mainHasHScroll: main ? main.scrollWidth > main.clientWidth : null,
        nestedScrollers: nestedScrollers.slice(0, 3),
      };
    });
    const pass =
      overflowState.mainOverflowX === "hidden" &&
      overflowState.mainHasHScroll === false;
    record("AC3_no_nested_h_scrollbars", pass, overflowState);
  } catch (e) {
    record("AC3_no_nested_h_scrollbars", false, { error: String(e).slice(0, 200) });
  }

  // ============= AC4: sidebar fully visible at 1280×500 =============
  try {
    await page.setViewportSize({ width: 1280, height: 500 });
    await gotoShell(`${BASE}/${ORG_SLUG}`);
    const sidebarState = await page.evaluate(() => {
      const aside = document.querySelector("aside");
      if (!aside) return { aside: null };
      const nav = aside.querySelector("nav");
      const userBtn = aside.querySelector("button[aria-haspopup], aside > div:last-child");
      const aRect = aside.getBoundingClientRect();
      const nRect = nav?.getBoundingClientRect();
      const uRect = userBtn?.getBoundingClientRect();
      return {
        viewportH: window.innerHeight,
        aside: {
          top: aRect.top,
          bottom: aRect.bottom,
          height: aRect.height,
        },
        nav: nRect ? {
          height: nRect.height,
          scrollHeight: nav.scrollHeight,
          clientHeight: nav.clientHeight,
          internallyScrollable: nav.scrollHeight > nav.clientHeight,
        } : null,
        userArea: uRect ? {
          top: uRect.top,
          bottom: uRect.bottom,
          visible: uRect.bottom <= window.innerHeight + 1 && uRect.top >= 0,
        } : null,
      };
    });
    const pass =
      sidebarState.aside &&
      sidebarState.aside.bottom <= sidebarState.viewportH + 1 &&
      sidebarState.userArea?.visible === true;
    record("AC4_sidebar_visible_1280x500", !!pass, sidebarState);
  } catch (e) {
    record("AC4_sidebar_visible_1280x500", false, { error: String(e).slice(0, 200) });
  }

  // ============= AC5: unsaved bar doesn't overlap mobile bottom nav =============
  try {
    await page.setViewportSize({ width: 375, height: 667 });
    await gotoShell(`${BASE}/${ORG_SLUG}/settings/preferences`);
    // Dirty the form: click a theme-mode button that's NOT currently selected.
    // The component uses border-primary ring-2 ring-primary/20 to indicate the
    // active option; we click any other one.
    await page.evaluate(() => {
      // Find theme-mode buttons (4 of them rendered in a grid). We don't know
      // which is active in the DB, so click each one until dirty bar appears.
      // We'll just click the first that doesn't have ring-2 class.
      const buttons = document.querySelectorAll('button[type="button"]');
      for (const b of buttons) {
        if (!b.className.includes("ring-2") && /Light|Dark|System|Compact|Comfortable|Spacious/.test(b.textContent || "")) {
          b.click();
          break;
        }
      }
    });
    await sleep(500);
    const overlap = await page.evaluate(() => {
      // Find the unsaved-changes bar and the mobile bottom-nav
      const fixedEls = Array.from(document.querySelectorAll("div.fixed, nav.fixed"));
      const findByText = (text) => fixedEls.find((el) => (el.textContent || "").includes(text));
      const unsavedBar = findByText("Unsaved changes");
      const bottomNav = document.querySelector("nav.fixed.bottom-0, nav[class*='bottom-0'][class*='fixed']");
      if (!unsavedBar || !bottomNav) {
        return {
          foundUnsaved: !!unsavedBar,
          foundBottomNav: !!bottomNav,
          fixedCount: fixedEls.length,
        };
      }
      const u = unsavedBar.getBoundingClientRect();
      const n = bottomNav.getBoundingClientRect();
      return {
        viewportH: window.innerHeight,
        unsaved: { top: u.top, bottom: u.bottom, height: u.height },
        bottomNav: { top: n.top, bottom: n.bottom, height: n.height },
        unsavedClearsNav: u.bottom <= n.top + 1,
      };
    });
    const pass = overlap.unsavedClearsNav === true;
    record("AC5_unsaved_bar_clears_mobile_nav", pass, overlap);
  } catch (e) {
    record("AC5_unsaved_bar_clears_mobile_nav", false, { error: String(e).slice(0, 200) });
  }

  // ============= AC6: no body-level vertical scrollbar on modal open =============
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoShell(`${BASE}/${ORG_SLUG}`);
    const before = await page.evaluate(() => ({
      htmlScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      bodyScroll: document.body.scrollHeight - document.body.clientHeight,
      windowY: window.scrollY,
    }));
    // Open command palette (registered global event)
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("cosmos:command-palette:open"));
    });
    await sleep(500);
    const during = await page.evaluate(() => ({
      htmlScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      bodyScroll: document.body.scrollHeight - document.body.clientHeight,
      windowY: window.scrollY,
      dialogOpen: !!document.querySelector("[role=dialog], [data-state=open][data-slot=dialog-content]"),
    }));
    // Close it (Escape)
    await page.keyboard.press("Escape");
    await sleep(300);
    const after = await page.evaluate(() => ({
      htmlScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      bodyScroll: document.body.scrollHeight - document.body.clientHeight,
    }));
    const pass =
      during.htmlScroll === 0 &&
      during.bodyScroll === 0 &&
      after.htmlScroll === 0 &&
      after.bodyScroll === 0;
    record("AC6_no_body_scrollbar_on_modal", pass, { before, during, after });
  } catch (e) {
    record("AC6_no_body_scrollbar_on_modal", false, { error: String(e).slice(0, 200) });
  }

  await browser.close();

  const allPass = Object.values(report.criteria).every((c) => c.pass);
  report.summary = { allPass, passCount: Object.values(report.criteria).filter((c) => c.pass).length, totalCount: Object.keys(report.criteria).length };
  console.log(JSON.stringify(report, null, 2));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
