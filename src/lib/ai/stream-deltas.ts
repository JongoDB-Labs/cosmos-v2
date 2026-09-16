// src/lib/ai/stream-deltas.ts
//
// Pure helpers for the assistant's SSE text stream. No I/O — both the route
// (server) and the assistant panel (browser) import this, so the two ends
// measure the same stream the same way.
//
// WHY THIS EXISTS
// `runAgentLoop`'s `onDelta` carries the CUMULATIVE text of the CURRENT turn,
// and the loop resets that buffer on every turn: a tool-using run streams a
// preamble in turn N and the real answer in turn N+1, each starting from "".
// A consumer that tracks one "sent so far" offset across the whole run
// therefore mis-slices the moment a second turn starts — every delta shorter
// than the preamble is dropped, and the first one that finally exceeds it is
// emitted with its head cut off. On screen that reads as a long silence
// followed by one big lump of text: the "several chunks of tokens at a time"
// this module exists to remove. `createDeltaTracker` is turn-aware, so every
// delta is forwarded exactly once, in the order the model produced it.

export interface DeltaTracker {
  /**
   * Given the loop's cumulative text for the current turn, return ONLY the
   * newly-appended slice (`""` when there is nothing new to forward).
   */
  next(textSoFar: string): string;
  /** Everything handed out so far, across every turn. */
  sent(): string;
}

export function createDeltaTracker(): DeltaTracker {
  // What we've forwarded for the CURRENT turn — reset when the loop's buffer
  // restarts — and the whole run's forwarded text, in order.
  let turnSent = "";
  let all = "";
  return {
    next(textSoFar: string): string {
      // A new turn: `textSoFar` is no longer an extension of what we forwarded,
      // so none of it has been sent yet. Start the turn offset over rather than
      // slicing the new turn's text at the old turn's length.
      if (!textSoFar.startsWith(turnSent)) turnSent = "";
      if (textSoFar.length <= turnSent.length) return "";
      const delta = textSoFar.slice(turnSent.length);
      turnSent = textSoFar;
      all += delta;
      return delta;
    },
    sent: () => all,
  };
}

/** Latency shape of one streamed answer. Counts and milliseconds only — never text. */
export interface StreamTiming {
  /** Time to first token: ms from the request starting to the first forwarded delta. */
  ttftMs: number | null;
  /** How many deltas were forwarded (a proxy for streaming granularity). */
  deltas: number;
  /** Characters streamed, so `chars / deltas` shows how coarse the chunking was. */
  chars: number;
  /** Mean gap between consecutive deltas (null with fewer than two). */
  meanGapMs: number | null;
  /** Worst gap between consecutive deltas — the stall a user actually notices. */
  maxGapMs: number | null;
}

/**
 * Summarize a stream's latency from the timestamps of the deltas that were
 * forwarded. Pure: the caller supplies the clock readings.
 */
export function summarizeStreamTiming(
  startedAt: number,
  deltaAt: readonly number[],
  chars: number,
): StreamTiming {
  if (deltaAt.length === 0) {
    return { ttftMs: null, deltas: 0, chars, meanGapMs: null, maxGapMs: null };
  }
  let total = 0;
  let max = 0;
  for (let i = 1; i < deltaAt.length; i++) {
    const gap = deltaAt[i] - deltaAt[i - 1];
    total += gap;
    if (gap > max) max = gap;
  }
  const gaps = deltaAt.length - 1;
  return {
    ttftMs: deltaAt[0] - startedAt,
    deltas: deltaAt.length,
    chars,
    meanGapMs: gaps > 0 ? Math.round(total / gaps) : null,
    maxGapMs: gaps > 0 ? max : null,
  };
}
