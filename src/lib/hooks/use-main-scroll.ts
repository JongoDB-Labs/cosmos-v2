"use client";

import { useEffect, useRef, type RefObject } from "react";
import { usePathname } from "next/navigation";

/**
 * The dashboard uses `main` as the single scroller, so the browser's native
 * `window`-level scroll restoration (and Next.js's `scrollTo(0, 0)` after a
 * route change) is a no-op. These hooks reproduce that behavior on the
 * element-level scroller.
 *
 * The cache survives only for the lifetime of the SPA session — module-scope
 * Map is intentional. Hard reloads should restart at top.
 */
const scrollMap = new Map<string, number>();

// While a route navigation is in flight (link clicked but not yet observed in
// `usePathname()`), suppress scroll-save events: any scroll fired during this
// window is the browser clamping `main.scrollTop` because the new page's
// shorter content has replaced the old, not a real user scroll.
let suppressSavesUntilPathname: string | null = null;

const HEADER_OFFSET = 80;

export function useMainScrollRestorer(
  mainRef: RefObject<HTMLElement | null>,
) {
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);

  // Save scrollTop on user-initiated input events (wheel / touchmove /
  // keydown / scrollbar drag), not generic `scroll` events. Generic scroll
  // events also fire when the browser clamps `main.scrollTop` because the
  // page's content just shrank under a route change — that clamped value
  // would clobber the user's real position before our pathname effect can
  // save it.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    let frame = 0;
    function save() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!el) return;
        scrollMap.set(pathnameRef.current, el.scrollTop);
      });
    }
    function onUserScroll() {
      // Schedule the save for the next frame so the browser has applied the
      // event's effect to `scrollTop` before we read it.
      save();
    }
    el.addEventListener("wheel", onUserScroll, { passive: true });
    el.addEventListener("touchmove", onUserScroll, { passive: true });
    el.addEventListener("keydown", onUserScroll, true);
    // Scrollbar drags don't fire wheel/touchmove. Track them via a brief
    // "scroll-attributed-to-user" window after pointer/mouse events on the
    // scroller's own area.
    let userPointerActive = false;
    let pointerEndAt = 0;
    function onPointerDown() {
      userPointerActive = true;
    }
    function onPointerUp() {
      userPointerActive = false;
      pointerEndAt = performance.now();
    }
    function onScroll() {
      if (frame) return;
      if (suppressSavesUntilPathname !== null) return;
      const now = performance.now();
      if (!userPointerActive && now - pointerEndAt > 100) return;
      save();
    }
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    el.addEventListener("pointerup", onPointerUp, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", onUserScroll);
      el.removeEventListener("touchmove", onUserScroll);
      el.removeEventListener("keydown", onUserScroll, true);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [mainRef]);

  // Intercept anchor interactions and arm the save-suppression latch so that
  // the scroll listener doesn't overwrite the saved value when the new
  // page's shorter content clamps `main.scrollTop` to a smaller number.
  //
  // We listen on `pointerdown` (rather than `click`) because Next.js's Link
  // begins prefetching and committing the route on pointerdown — by the
  // time `click` fires, content may already have swapped.
  useEffect(() => {
    function snapshot(e: Event) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      let targetPathname: string;
      try {
        const url = new URL(anchor.href, window.location.href);
        if (url.origin !== window.location.origin) return;
        if (url.pathname === window.location.pathname) return;
        targetPathname = url.pathname;
      } catch {
        return;
      }
      const el = mainRef.current;
      if (el) {
        scrollMap.set(pathnameRef.current, el.scrollTop);
        suppressSavesUntilPathname = targetPathname;
      }
    }
    document.addEventListener("pointerdown", snapshot, true);
    document.addEventListener("click", snapshot, true);
    return () => {
      document.removeEventListener("pointerdown", snapshot, true);
      document.removeEventListener("click", snapshot, true);
    };
  }, [mainRef]);

  // On pathname change, restore the saved scrollTop for the new path. The
  // assignment is non-trivial: new content streams in via Suspense, so the
  // scroller may not be tall enough to honour the value on first commit.
  // We watch `main` for size changes and re-apply scrollTop each time the
  // scroller grows, until we hit the saved value or a 1.5s wall-clock cap.
  useEffect(() => {
    pathnameRef.current = pathname;
    // Release the save-suppression latch now that the new pathname is live.
    if (suppressSavesUntilPathname === pathname) {
      suppressSavesUntilPathname = null;
    }
    const el = mainRef.current;
    if (!el) return;
    const saved = scrollMap.get(pathname) ?? 0;
    el.scrollTop = saved;
    if (saved === 0) return;

    const deadline = performance.now() + 1500;
    let cancelled = false;
    function tryApply() {
      if (cancelled || !el) return;
      el.scrollTop = saved;
      if (el.scrollTop >= saved - 1) return; // success
      if (performance.now() > deadline) return; // give up
      requestAnimationFrame(tryApply);
    }
    requestAnimationFrame(tryApply);

    const observer = new ResizeObserver(() => {
      if (cancelled || !el) return;
      if (el.scrollTop < saved - 1 && performance.now() <= deadline) {
        el.scrollTop = saved;
      }
    });
    // Observe both the scroller and its first child wrapper — children added
    // by Suspense reveal beneath main don't always trigger a main resize.
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [pathname, mainRef]);
}

export function useHashAnchorScroll(
  mainRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    function scrollToHash() {
      const hash = window.location.hash;
      const main = mainRef.current;
      if (!hash || !main) return;
      const id = decodeURIComponent(hash.slice(1));
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      const mainRect = main.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const top = targetRect.top - mainRect.top + main.scrollTop - HEADER_OFFSET;
      main.scrollTo({ top, behavior: "smooth" });
    }
    scrollToHash();
    window.addEventListener("hashchange", scrollToHash);
    return () => window.removeEventListener("hashchange", scrollToHash);
  }, [mainRef]);
}
