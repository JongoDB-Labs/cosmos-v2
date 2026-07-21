/**
 * Best-effort recorder for the loop-graph in OBSERVER mode. The daemon (run.mts)
 * emits DaemonSignals at its real phase/outcome sites; here we translate each into
 * an engine Event, fold it through the SAME pure reduce() the driver will later use,
 * and persist the projection (foreman_loop_state) + append the transition log
 * (foreman_loop_transition). Every export is best-effort + fire-and-forget — a
 * failure here can NEVER affect delivery, and the daemon never awaits it.
 *
 * Two guarantees live here so run.mts stays a set of plain synchronous calls:
 *  1. Mode gate: recording happens only for orgs whose ForemanLoopSettings.mode is
 *     "shadow"|"live" ("off", the default, records nothing). Cached with a short TTL
 *     so enabling an org is picked up without a daemon restart.
 *  2. Per-loop serialization: emits are fire-and-forget, so they are chained per loop
 *     to fold in issue order (else `checks` could apply before `built`).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TicketBrief } from "@/lib/foreman/prompt";
import { initialState, serialize, deserialize, type LoopState } from "@/lib/foreman/loop/state";
import { reduce } from "@/lib/foreman/loop/reduce";
import { translate, type DaemonSignal } from "@/lib/foreman/loop/translate";
import { classify } from "@/lib/foreman/loop/convergence";
import type { LoopSettings } from "@/lib/foreman/loop/mode";
import { getForemanLoopSettings } from "./loop-mode.mjs";

const loopCache = new Map<string, LoopState>();
const lastTransitionMs = new Map<string, number>();
// Loops that have already emitted a shadow-divergence event — at most one per loop
// (else a loop stuck past a cap would spam one event per subsequent transition).
const shadowFlagged = new Set<string>();

// Per-loop promise chain: preserves fold order for concurrent fire-and-forget emits.
const chains = new Map<string, Promise<void>>();
function serialize_(loopId: string, fn: () => Promise<void>): Promise<void> {
  const prev = chains.get(loopId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn regardless of the prior op's outcome
  const tracked = next.finally(() => { if (chains.get(loopId) === tracked) chains.delete(loopId); });
  chains.set(loopId, tracked);
  return tracked;
}

// Settings gate with a 60s TTL cache (keyed by orgId). Returns the org's loop
// settings when recording is on (mode shadow|live), else null ("off" records
// nothing). Cached so enabling an org is picked up without a daemon restart.
const SETTINGS_TTL_MS = 60_000;
const settingsCache = new Map<string, { settings: LoopSettings | null; at: number }>();
async function getSettings(orgId: string, nowMs: number): Promise<LoopSettings | null> {
  const hit = settingsCache.get(orgId);
  if (hit && nowMs - hit.at < SETTINGS_TTL_MS) return hit.settings;
  let settings: LoopSettings | null = null;
  try {
    const s = await getForemanLoopSettings(orgId);
    settings = s.mode === "off" ? null : s;
  } catch { settings = null; }
  settingsCache.set(orgId, { settings, at: nowMs });
  return settings;
}

const asJson = (v: unknown): Prisma.InputJsonValue => v as unknown as Prisma.InputJsonValue;
function warn(msg: string): void {
  console.warn(`[loop-io] ${msg}`);
}

/** Begin a loop (fire-and-forget). Seeds initialState + upserts the projection at
 *  iteration 0 — only if the org opts in. Ordered ahead of that loop's signals. */
export function beginLoop(item: { id: string; orgId: string; brief: TicketBrief }, nowMs: number): Promise<void> {
  return serialize_(item.id, async () => {
    if (!(await getSettings(item.orgId, nowMs))) return;
    try {
      // Idempotent: a ticket that errors mid-build is re-claimed (up to MAX_ATTEMPTS),
      // re-firing beginLoop. Do NOT rewind an already-tracked loop to iteration 0 —
      // that would collide with its prior rows on @@unique([loopId,iteration]) and
      // wedge recording. Adopt the existing loop (in-memory, else persisted) and
      // continue; only seed a fresh loop when none exists.
      if (loopCache.has(item.id)) return;
      const existing = await prisma.foremanLoopState.findUnique({ where: { loopId: item.id } });
      if (existing) {
        try {
          loopCache.set(item.id, deserialize(existing.state));
          lastTransitionMs.set(item.id, nowMs);
        } catch { /* malformed persisted state → leave untracked; emits will drop */ }
        return;
      }
      const state = initialState(item.id, item.orgId, item.brief, nowMs);
      loopCache.set(item.id, state);
      lastTransitionMs.set(item.id, nowMs);
      const projection = {
        orgId: item.orgId, status: "running", phase: state.phase,
        iteration: 0, schemaVersion: state.schemaVersion, state: asJson(serialize(state)),
      };
      await prisma.foremanLoopState.upsert({
        where: { loopId: item.id },
        create: { loopId: item.id, ...projection },
        update: projection,
      });
    } catch (e) {
      warn(`beginLoop ${item.id}: ${String(e)}`);
    }
  });
}

async function loadState(loopId: string): Promise<LoopState | null> {
  const cached = loopCache.get(loopId);
  if (cached) return cached;
  const row = await prisma.foremanLoopState.findUnique({ where: { loopId } });
  if (!row) return null;
  try {
    const s = deserialize(row.state);
    loopCache.set(loopId, s);
    return s;
  } catch {
    return null;
  }
}

/** Emit a daemon signal (fire-and-forget). Folds via reduce, appends a transition,
 *  upserts the projection — only if the loop was begun AND the org opts in. The org
 *  is derived from the loop's own state, so callers need only the loopId. Serialized
 *  per loop so concurrent fire-and-forget emits fold in issue order. */
export function emit(loopId: string, signal: DaemonSignal, nowMs: number): Promise<void> {
  return serialize_(loopId, async () => {
    try {
      const state = await loadState(loopId);
      if (!state) return; // no begun loop → drop (recording was off at begin, or a resume-path build)
      if (state.terminationSignal) return; // already terminal → don't append past the end (e.g. a resume ship onto a parked loop)
      const settings = await getSettings(state.orgId, nowMs);
      if (!settings) return; // org turned recording off
      const event = translate(signal);
      if (!event) return;

      const fromPhase = state.phase;
      // Observer mode records what the daemon ACTUALLY did. A loop terminates only on
      // a genuine terminal EVENT (shipped/parked/fatal — set by reduce), NEVER on the
      // engine's own convergence caps (attempts / wall-clock / stall). Applying those
      // here would prematurely mark a still-running loop terminal and then silently
      // drop the daemon's real ship. The caps belong to the DRIVER (Phase 6), not the
      // recorder.
      const next = reduce(state, event);

      // Phase 5 shadow: run the convergence contract WITHOUT acting on it. The
      // dangerous divergence for live-driving (Phase 6) is a premature terminate —
      // classify would stop a loop the daemon is still progressing (and may go on to
      // ship). Surface those as `loop_shadow_divergence` events (at most one per loop)
      // so the engine's agreement with reality is measurable BEFORE it is ever allowed
      // to drive. NOTE: this over-counts conservatively by up to one transition — when
      // the daemon is itself about to terminate (e.g. hits wall-clock then parks next
      // signal), classify fires one transition earlier, so both sides agree on the
      // outcome yet it's flagged. Erring toward caution before Phase 6 is intended.
      if (!next.terminationSignal && !shadowFlagged.has(loopId)) {
        const verdict = classify(next, nowMs, settings.budgets);
        if (verdict.status === "terminal") {
          shadowFlagged.add(loopId); // one divergence per loop, not per transition
          warn(`[shadow] ${loopId}: engine would ${verdict.signal} at iter ${next.iteration} (${verdict.reason}) — daemon still running`);
          await prisma.foremanEvent
            .create({
              data: {
                orgId: next.orgId, workItemId: loopId, kind: "loop_shadow_divergence", severity: "info",
                message: `engine would ${verdict.signal} at iteration ${next.iteration} but the daemon continued`,
                data: asJson({ signal: verdict.signal, reason: verdict.reason, iteration: next.iteration, phase: next.phase }),
              },
            })
            .catch(() => undefined);
        }
      }
      const prevMs = lastTransitionMs.get(loopId) ?? state.startedAtMs;
      const durationMs = Math.max(0, nowMs - prevMs);
      lastTransitionMs.set(loopId, nowMs);
      const terminal = next.terminationSignal != null;

      await prisma.foremanLoopTransition.create({
        data: {
          loopId, orgId: next.orgId, iteration: next.iteration,
          fromPhase, toPhase: next.phase, action: event.kind,
          terminationSignal: next.terminationSignal ?? null,
          invariantResults: asJson([]), durationMs,
          tokensIn: 0, tokensOut: 0, costUsd: 0,
          stateSnapshot: asJson(serialize(next)),
        },
      });
      const projection = {
        status: terminal ? next.terminationSignal! : "running",
        phase: next.phase, iteration: next.iteration,
        schemaVersion: next.schemaVersion, state: asJson(serialize(next)),
      };
      await prisma.foremanLoopState.upsert({
        where: { loopId },
        create: { loopId, orgId: next.orgId, ...projection },
        update: projection,
      });

      if (terminal) {
        loopCache.delete(loopId);
        lastTransitionMs.delete(loopId);
        shadowFlagged.delete(loopId);
      } else {
        loopCache.set(loopId, next);
      }
    } catch (e) {
      warn(`emit ${loopId} ${signal.kind}: ${String(e)}`);
    }
  });
}
