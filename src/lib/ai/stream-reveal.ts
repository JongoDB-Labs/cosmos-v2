// src/lib/ai/stream-reveal.ts
//
// Client-side "smooth reveal" for streamed assistant text (COSMOS-24).
//
// The assistant streams text one model delta per SSE `text` event, and the
// route already sets the correct anti-buffering headers (`no-transform`,
// `X-Accel-Buffering: no`). But the network path between the browser and the
// app — Cloudflare, the caddy←nginx :80 hop, HTTP/2 framing, TCP coalescing —
// commonly COALESCES many small per-token writes into a few larger reads. The
// chat client renders each `reader.read()` burst atomically (React batches the
// synchronous state updates in the SSE parse loop), so the user sees "several
// chunks of tokens at a time" instead of a fluid stream.
//
// The reference implementation (okr-dashboard) smooths this by `res.flush()`ing
// every SSE write server-side AND revealing canned text word-by-word on a timer
// (`streamWords`). We generalize the latter to the LIVE token stream: decouple
// the DISPLAY cadence from the ARRIVAL cadence by revealing the received text a
// few characters per animation frame. Bursts get spread into a smooth reveal;
// when the backlog is large (a big coalesced read) the reveal accelerates so it
// never lags far behind (ease-out), and it always drains to the exact final
// text at the end.

/** Minimum characters revealed per frame so a slow trickle still feels alive. */
export const REVEAL_MIN_CHARS_PER_FRAME = 2;
/** Backlog divisor for the ease-out rate (reveal ≈ backlog/divisor per frame). */
export const REVEAL_BACKLOG_DIVISOR = 6;

/**
 * Characters to reveal on the next frame given how much is shown vs. received.
 * Ease-out: catch up quickly on a large backlog (a coalesced network burst),
 * gently when nearly caught up (feels like typing). Never returns more than the
 * remaining backlog, and never a negative value.
 */
export function nextRevealCount(displayedLen: number, targetLen: number): number {
  const backlog = targetLen - displayedLen;
  if (backlog <= 0) return 0;
  return Math.min(
    backlog,
    Math.max(REVEAL_MIN_CHARS_PER_FRAME, Math.ceil(backlog / REVEAL_BACKLOG_DIVISOR)),
  );
}

export interface RevealScheduler {
  request(cb: () => void): number;
  cancel(handle: number): void;
}

/** requestAnimationFrame-backed scheduler; degrades to setTimeout off-DOM. */
const rafScheduler: RevealScheduler = {
  request: (cb) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(cb)
      : (setTimeout(cb, 16) as unknown as number),
  cancel: (h) => {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(h);
    else clearTimeout(h);
  },
};

export interface TextRevealOptions {
  /** Called with the text to display so far, at most once per frame. */
  onUpdate: (text: string) => void;
  /** Called once when the reveal has drained to its final target (finish/flush). */
  onSettled?: () => void;
  /** Frame scheduler; defaults to requestAnimationFrame. Injectable for tests. */
  scheduler?: RevealScheduler;
}

export interface TextReveal {
  /** Extend the received text; keeps (or resumes) the smooth reveal. */
  push(fullText: string): void;
  /** Mark the final received text; drain the remaining backlog, then settle. */
  finish(fullText: string): void;
  /** Jump straight to the current target and settle now (no animation). */
  flush(): void;
  /** Cancel the reveal loop without forcing full text or firing onSettled. */
  stop(): void;
  /** Resolves once the reveal has settled (via finish/flush) or been stopped. */
  done(): Promise<void>;
}

/**
 * Create a smooth text-reveal controller. Feed it the cumulative received text
 * via `push(...)`; it reveals that text to `onUpdate` a few chars per frame.
 * Call `finish(finalText)` when the stream ends to drain and settle.
 *
 * The target is assumed append-only (the chat stream only ever grows); a
 * shorter target is clamped rather than rewinding the display.
 */
export function createTextReveal(opts: TextRevealOptions): TextReveal {
  const scheduler = opts.scheduler ?? rafScheduler;
  let target = "";
  let displayedLen = 0;
  let handle: number | null = null;
  let finishing = false;
  let settled = false;
  let waiters: Array<() => void> = [];

  const resolveWaiters = () => {
    const w = waiters;
    waiters = [];
    for (const r of w) r();
  };

  const cancelFrame = () => {
    if (handle !== null) {
      scheduler.cancel(handle);
      handle = null;
    }
  };

  const settle = () => {
    if (settled) return;
    settled = true;
    cancelFrame();
    // Guarantee the displayed text exactly equals the final target.
    displayedLen = target.length;
    opts.onUpdate(target);
    opts.onSettled?.();
    resolveWaiters();
  };

  const schedule = () => {
    if (settled || handle !== null) return;
    handle = scheduler.request(tick);
  };

  function tick() {
    handle = null;
    if (settled) return;
    const count = nextRevealCount(displayedLen, target.length);
    if (count > 0) {
      displayedLen += count;
      opts.onUpdate(target.slice(0, displayedLen));
    }
    if (displayedLen < target.length) {
      schedule();
    } else if (finishing) {
      settle();
    }
  }

  return {
    push(fullText: string) {
      if (settled || finishing) return;
      if (fullText.length > target.length) target = fullText;
      schedule();
    },
    finish(fullText: string) {
      if (settled) {
        resolveWaiters();
        return;
      }
      finishing = true;
      if (fullText.length >= target.length) target = fullText;
      if (displayedLen >= target.length) settle();
      else schedule();
    },
    flush() {
      settle();
    },
    stop() {
      if (settled) {
        resolveWaiters();
        return;
      }
      // Freeze wherever we are — do NOT force full text or fire onSettled.
      settled = true;
      cancelFrame();
      resolveWaiters();
    },
    done() {
      if (settled) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}
