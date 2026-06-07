// scripts/cutover/lib/snapshot.ts
//
// Pure helpers for the §9.4 pre-flip SNAPSHOT CAPTURE + precise PITR RESTORE of the
// per-tenant cutover rollback (scripts/cutover/snapshot-capture.mjs +
// scripts/dsop/restore-to-point-drill.sh + the orchestrator's rollback emitter).
//
// Side-effect-free so they unit-test without a database, a clock, or the filesystem:
//
//   * buildCreateRestorePointSql() — the `SELECT pg_create_restore_point('<label>')` SQL
//     that stamps a NAMED PITR target into the WAL stream + returns its LSN. The label is
//     validated + single-quote-escaped (it lands in a SQL string literal).
//
//   * buildRestoreCommand() — the PRECISE pgBackRest restore command for a captured point.
//     A target is MANDATORY (named OR time): a restore with no target replays to the end of
//     the WAL = NOT a rollback to the pre-flip point. Throws if asked to build a targetless
//     restore — the one thing we must never emit.
//
//   * buildSnapshotRecord() / parseSnapshotRecord() — assemble/validate the snapshot record
//     persisted into the cutover --state. Timestamps are passed IN (Date.now() may be
//     restricted under tsx; the orchestrator/CLI supplies --stamp).
//
// DESTRUCTIVE-RESTORE SAFETY: these helpers only BUILD strings + records. Nothing here runs
// a restore. The restore command is for an operator to run by hand (it overwrites a datadir);
// the orchestrator emits it but NEVER executes it. The PITR drill runs it ONLY against a
// scratch cluster.

// ── Validation ────────────────────────────────────────────────────────────────────────

// A PG restore-point name is stored verbatim; keep it conservative + path/shell-safe so it
// is also safe as a --target token on a pgBackRest command line. (Letters, digits, and
// - _ . : are plenty for a "cutover-<slug>-preflip" style label.)
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}$/;

/** Assert a restore-point label is well-formed; returns it. Fail-closed on anything odd. */
export function assertValidLabel(label: string): string {
  if (typeof label !== "string" || !LABEL_RE.test(label)) {
    throw new Error(
      `snapshot: invalid restore-point label ${JSON.stringify(label)} — must match ${LABEL_RE} ` +
        `(letters/digits then [A-Za-z0-9_.:-], ≤63 chars)`,
    );
  }
  return label;
}

/** Single-quote-escape a value for inlining into a SQL string literal. */
function sqlLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ── SQL builder ─────────────────────────────────────────────────────────────────────────

/**
 * Build `SELECT pg_create_restore_point('<label>') AS lsn;`. pg_create_restore_point is a
 * SUPERUSER (or pg_checkpoint) function that writes a named restore point into the WAL and
 * returns the LSN of that record — the precise PITR target. The label is validated then
 * single-quote-escaped (defense in depth; assertValidLabel already excludes quotes).
 */
export function buildCreateRestorePointSql(label: string): string {
  assertValidLabel(label);
  return `SELECT pg_create_restore_point(${sqlLit(label)}) AS lsn;`;
}

// ── Restore-command builder (the one that must NEVER be targetless) ──────────────────────

export type RestoreTarget =
  | { type: "name"; target: string }
  | { type: "time"; target: string };

export interface RestoreCommandOpts {
  stanza: string;
  target: RestoreTarget;
  /**
   * Promote after reaching the target (the common case: bring the restored cluster up R/W
   * at the point). Maps to --target-action=promote. Default true.
   */
  promote?: boolean;
  /**
   * --delta restore (reuse the existing datadir, only fetching changed files) vs a full
   * clean restore into an empty datadir. Default false (the drill restores into a fresh
   * scratch datadir; an operator restoring the live cluster typically wants --delta).
   */
  delta?: boolean;
}

/**
 * Build the PRECISE pgBackRest restore command for a captured point, as a string AND as an
 * argv array (so a caller can spawn it without a shell). A target is MANDATORY:
 *
 *   pgbackrest --stanza=<stanza> --type=name --target=<label> [--target-action=promote] [--delta] restore
 *   pgbackrest --stanza=<stanza> --type=time --target=<iso-ts> [--target-action=promote] [--delta] restore
 *
 * THROWS if the target is missing/empty — a restore with no target replays to the end of the
 * WAL, which is NOT a point-in-time rollback. This is the single invariant the unit tests pin:
 * we never emit a targetless (replay-to-end) restore.
 */
export function buildRestoreArgv(opts: RestoreCommandOpts): string[] {
  const stanza = opts.stanza;
  if (typeof stanza !== "string" || stanza.trim() === "") {
    throw new Error("snapshot: buildRestoreArgv requires a non-empty stanza");
  }
  const t = opts.target;
  if (!t || (t.type !== "name" && t.type !== "time")) {
    throw new Error('snapshot: restore target must be {type:"name"|"time", target}');
  }
  if (typeof t.target !== "string" || t.target.trim() === "") {
    throw new Error(
      `snapshot: refusing to build a TARGETLESS restore (type=${t?.type}) — a restore with no ` +
        `--target replays to the end of WAL and is NOT a point-in-time rollback`,
    );
  }
  if (t.type === "name") assertValidLabel(t.target);

  const promote = opts.promote ?? true;
  const argv = ["pgbackrest", `--stanza=${stanza}`, `--type=${t.type}`, `--target=${t.target}`];
  if (promote) argv.push("--target-action=promote");
  if (opts.delta) argv.push("--delta");
  argv.push("restore");
  return argv;
}

/** The same precise restore command as a single shell-quoted string (for printing/runbooks). */
export function buildRestoreCommand(opts: RestoreCommandOpts): string {
  return buildRestoreArgv(opts).map(shellQuote).join(" ");
}

/** Minimal POSIX shell quoting: only quote tokens that need it. */
function shellQuote(tok: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(tok)) return tok;
  return `'${tok.replace(/'/g, "'\\''")}'`;
}

// ── Snapshot record (persisted into the cutover --state) ────────────────────────────────

export interface SnapshotRecord {
  /** The named restore point (the primary PITR target). */
  label: string;
  /** The LSN returned by pg_create_restore_point (e.g. "0/1A2B3C0"), or null if unavailable. */
  lsn: string | null;
  /** server now() at capture (ISO-8601) — the --type=time PITR target fallback. */
  restorePointTime: string;
  /** The pgBackRest stanza the restore point lives in. */
  stanza: string;
  /** Timeline id at capture (from pg_control_checkpoint), or null if unavailable. */
  timeline: number | null;
  /** When the capture ran (the run --stamp), ISO-8601. */
  capturedAt: string;
  /**
   * The pgBackRest backup label of the incr/anchor backup taken at capture, if pgBackRest
   * was available. Absent ⇒ the restore point + LSN/time alone are the PITR target (the
   * existing WAL chain + last base backup still make it restorable).
   */
  backupLabel?: string | null;
}

export interface SnapshotInput {
  label: string;
  lsn?: string | null;
  restorePointTime: string;
  stanza: string;
  timeline?: number | null;
  capturedAt: string;
  backupLabel?: string | null;
}

/**
 * Assemble the snapshot record (no I/O). Validates the label + that the two required
 * timestamps are non-empty (a record with no restorePointTime AND no usable LSN would have
 * no PITR target — but the named label is always present here, so a named restore is always
 * possible; the time/LSN are belt-and-suspenders).
 */
export function buildSnapshotRecord(input: SnapshotInput): SnapshotRecord {
  assertValidLabel(input.label);
  if (typeof input.stanza !== "string" || input.stanza.trim() === "") {
    throw new Error("snapshot: buildSnapshotRecord requires a non-empty stanza");
  }
  if (typeof input.restorePointTime !== "string" || input.restorePointTime.trim() === "") {
    throw new Error("snapshot: buildSnapshotRecord requires restorePointTime (the --type=time target)");
  }
  if (typeof input.capturedAt !== "string" || input.capturedAt.trim() === "") {
    throw new Error("snapshot: buildSnapshotRecord requires capturedAt (the run stamp)");
  }
  return {
    label: input.label,
    lsn: input.lsn ?? null,
    restorePointTime: input.restorePointTime,
    stanza: input.stanza,
    timeline: input.timeline ?? null,
    capturedAt: input.capturedAt,
    backupLabel: input.backupLabel ?? null,
  };
}

/** Validate + return a SnapshotRecord parsed from JSON (fail-closed on a malformed record). */
export function parseSnapshotRecord(obj: unknown): SnapshotRecord {
  if (obj === null || typeof obj !== "object") {
    throw new Error("snapshot: snapshot record is not an object");
  }
  const r = obj as Record<string, unknown>;
  assertValidLabel(typeof r.label === "string" ? r.label : "");
  if (typeof r.stanza !== "string" || r.stanza.trim() === "") {
    throw new Error("snapshot: snapshot record missing stanza");
  }
  if (typeof r.restorePointTime !== "string" || r.restorePointTime.trim() === "") {
    throw new Error("snapshot: snapshot record missing restorePointTime");
  }
  if (typeof r.capturedAt !== "string" || r.capturedAt.trim() === "") {
    throw new Error("snapshot: snapshot record missing capturedAt");
  }
  return buildSnapshotRecord({
    label: r.label as string,
    lsn: (r.lsn as string | null | undefined) ?? null,
    restorePointTime: r.restorePointTime,
    stanza: r.stanza,
    timeline: typeof r.timeline === "number" ? r.timeline : null,
    capturedAt: r.capturedAt,
    backupLabel: (r.backupLabel as string | null | undefined) ?? null,
  });
}

/**
 * Build BOTH precise restore commands (named + time) for a captured snapshot record — what
 * the orchestrator emits on rollback. The named-target form is PRIMARY (the restore point is
 * the exact pre-flip WAL position); the time-target form is the fallback (same point, by
 * server clock). Both are operator-gated + destructive; neither is auto-run.
 */
export function restoreCommandsForRecord(
  rec: SnapshotRecord,
  opts: { delta?: boolean; promote?: boolean } = {},
): { named: string; time: string } {
  const base = { stanza: rec.stanza, promote: opts.promote ?? true, delta: opts.delta ?? true };
  return {
    named: buildRestoreCommand({ ...base, target: { type: "name", target: rec.label } }),
    time: buildRestoreCommand({ ...base, target: { type: "time", target: rec.restorePointTime } }),
  };
}
