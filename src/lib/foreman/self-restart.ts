/**
 * Self-reload after a self-modifying ship.
 *
 * tsx loads Foreman's modules once at boot and never hot-reloads, so after the
 * daemon ships a change that touches its OWN runtime (`scripts/foreman/**` or
 * `src/lib/foreman/**`) it keeps executing the OLD code until it is restarted —
 * the v2.204.8 approve-path fix needed a manual restart before it took effect.
 *
 * This module holds the pure decision logic the orchestrator wires up: detect
 * the trigger (diff touches Foreman's runtime), guard against a restart loop
 * (arm at most once per shipped commit), and defer the restart until the daemon
 * is idle. The restart itself is a NON-ZERO process exit — the daemon's systemd
 * unit runs `Restart=on-failure`, so exiting non-zero brings it straight back up
 * on the now-current checkout (`mergePr` hard-resets the local repo to the merged
 * commit), whereas a clean/kill/breaker stop exits 0 and stays down.
 */

/** Paths whose change means Foreman's own runtime moved and the daemon must
 *  reload to pick it up. Mirrors the self-modification prefixes in `risk.ts`. */
export const FOREMAN_RUNTIME_PREFIXES = ["scripts/foreman/", "src/lib/foreman/"] as const;

/** True iff a shipped diff touched Foreman's own runtime code. */
export function touchesForemanRuntime(files: readonly string[]): boolean {
  return files.some((f) => FOREMAN_RUNTIME_PREFIXES.some((p) => f.startsWith(p)));
}

/**
 * Decide whether a just-shipped commit should arm a self-restart.
 *
 * Arms only when the diff touched Foreman's runtime AND we have not already
 * armed/restarted for this exact commit — the restart-loop guard (`lastRestartCommit`
 * is the persisted stamp of the commit we last armed on). An empty `shippedCommit`
 * (a git hiccup) never arms: without a commit identity the loop guard is blind.
 */
export function shouldArmSelfRestart(args: {
  files: readonly string[];
  shippedCommit: string;
  lastRestartCommit: string | null;
}): boolean {
  const { files, shippedCommit, lastRestartCommit } = args;
  if (!shippedCommit) return false;
  if (shippedCommit === lastRestartCommit) return false;
  return touchesForemanRuntime(files);
}

/**
 * Once armed, the restart is deferred until the daemon is idle: no builds holding
 * worker slots AND nothing in the in-flight registry (which keeps an entry alive
 * through a build's queued-ship + shipping phases). This guarantees an in-flight
 * ship or build is never cut off mid-flight.
 */
export function readyToRestart(args: {
  armed: boolean;
  inFlightBuilds: number;
  inFlightRegistry: number;
}): boolean {
  return args.armed && args.inFlightBuilds === 0 && args.inFlightRegistry === 0;
}
