#!/usr/bin/env node
// scripts/cutover/orchestrate.mjs — THE PER-TENANT CUTOVER ORCHESTRATOR (design spec §9.4).
//
//   Run under tsx (it imports the .ts proxy-control core + spawns the existing cutover tools):
//     npx tsx scripts/cutover/orchestrate.mjs \
//       --org <orgId-uuid> --slug <orgSlug> \
//       --source <SOURCE_DATABASE_URL> --target <OWNER_DATABASE_URL> \
//       --scratch <SCRATCH_DATABASE_URL> --shadow <SHADOW_DATABASE_URL> \
//       --prod-schema-dump <path.sql> --state <state.json> \
//       --proxy-admin <http://host:port>  (the cutover proxy's Caddy admin API base URL) \
//       [--v1 <dial>] [--v2 <dial>]       (logical upstream dials for a /load rewrite; defaults
//                                          read from the proxy's live config are NOT possible via
//                                          POST /load, so these MUST be supplied to drive a flip) \
//       [--tenant-class gov|commercial]   (DEFAULT commercial. "gov" ARMS the exposability
//                                          sign-off gate: a gov flip is BLOCKED unless a
//                                          human-reviewed + leak-tested sign-off matching the
//                                          CURRENT exposability-map hash exists at
//                                          compliance/exposability/signoff/<slug>.json.
//                                          Commercial flips are UNAFFECTED — the gate passes.) \
//       [--max-cycles N]                  (soak loop cap; default 10) \
//       [--stamp <iso8601>]               (the run timestamp; a CLI arg like the other tools) \
//       [--stanza <name>]                 (pgBackRest stanza for the pre-flip snapshot; default cosmos) \
//       [--snapshot-label <name>]         (the named restore point; default cutover-<slug>-preflip) \
//       [--pgbackrest-exec '<cmd…>']      (a command prefix that runs pgBackRest against the TARGET
//                                          cluster, e.g. "sudo docker compose exec -T -u postgres
//                                          cosmos-postgres". When set, capture also triggers an incr
//                                          backup; when absent the restore point + LSN/time is the target.) \
//       [--validate-snapshot]             (restore the captured point into a SCRATCH cluster (the drill)
//                                          before the flip to PROVE rollback works. Default: ON when
//                                          --pgbackrest-exec is set, OFF otherwise. --no-validate-snapshot
//                                          forces off.) \
//       [--dry-run | --confirm]           (DEFAULT --dry-run: print the plan, touch NOTHING)
//
// THE SEQUENCE (each step timestamp-logged; the verify gate is the canonical flip gate):
//   1. PARITY-GATE PRECHECK — parity-gate.mjs against the restored prod snapshot. FAIL ⇒ ABORT
//      (before any freeze; nothing to roll back).
//   2. SOAK — loop soak-sync.mjs until a cycle reports 0 upserts (caught up) OR --max-cycles.
//   3. FREEZE — proxy-control.freezeOrg(slug): writes to the org 405 at the proxy; reads pass.
//   4. RECONCILE — reconcile-org.mjs (final force-exact import + delete-extras + in-txn orphan
//      probe). It also runs verify-org internally as its Phase-4 gate.
//   5. VERIFY GATE — verify-org.mjs explicitly (the hard flip gate). ANY failure ⇒ ROLLBACK.
//   5b. SNAPSHOT CAPTURE — snapshot-capture.mjs on the TARGET: a NAMED pre-flip restore point
//       (pg_create_restore_point) + LSN/time/timeline (+ optional incr backup), recorded into the
//       run --state under .snapshot. The exact pre-flip PITR target the rollback restores to.
//   5c. SNAPSHOT VALIDATE (optional, --validate-snapshot) — restore-to-point-drill.sh restores the
//       captured point into a SCRATCH cluster (never the live one), proving the rollback works.
//   6. FLIP — proxy-control.setOrgUpstream(slug, "v2"): the org's path now routes to v2.
//   7. UNFREEZE — proxy-control.unfreezeOrg(slug): writes resume, now served by v2.
//
// ROLLBACK (any failure AT or AFTER freeze): setOrgUpstream(slug,"v1") + unfreezeOrg(slug) so the
// org is NEVER left frozen or half-flipped — this is the EXECUTED, NON-DESTRUCTIVE primary rollback
// (v1's columns are kept intact per §9.3-5, so v1 IS the live data rollback). Then EMIT the EXACT,
// DESTRUCTIVE, OPERATOR-GATED PITR restore command for the captured pre-flip restore point (needed
// only if v2 took post-flip writes) — the orchestrator NEVER auto-runs the destructive restore — and
// exit NON-ZERO. A failure BEFORE freeze (parity/soak) simply aborts (no proxy state to undo).
//
// SAFE-BY-DEFAULT: --dry-run is the DEFAULT. It prints the full plan + the resolved args and
// touches NOTHING — no parity run, no soak, no freeze, no reconcile, no flip. Only --confirm
// executes. BUILD-ONLY / SYNTHETIC-TEST ONLY: never point --source/--target/--proxy-admin at a
// real production stack without docs/runbooks/cutover.md + explicit sign-off + live coordination.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { ProxyControl } from "./lib/proxy-control.ts";
import { requireExposabilitySignoff, loadSignoffFromDisk } from "./lib/exposability.ts";
import { parseSnapshotRecord, restoreCommandsForRecord } from "./lib/snapshot.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i; // a path-safe slug (the dashboard route token)
const DEFAULT_MAX_CYCLES = 10;
const TENANT_CLASSES = new Set(["gov", "commercial"]);

function parseArgs(argv) {
  const out = { confirm: false, dryRun: false, maxCycles: DEFAULT_MAX_CYCLES };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--org") out.org = argv[++i];
    else if (a === "--slug") out.slug = argv[++i];
    else if (a === "--source") out.source = argv[++i];
    else if (a === "--target") out.target = argv[++i];
    else if (a === "--scratch") out.scratch = argv[++i];
    else if (a === "--shadow") out.shadow = argv[++i];
    else if (a === "--prod-schema-dump") out.dump = argv[++i];
    else if (a === "--state") out.state = argv[++i];
    else if (a === "--proxy-admin") out.proxyAdmin = argv[++i];
    else if (a === "--v1") out.v1 = argv[++i];
    else if (a === "--v2") out.v2 = argv[++i];
    else if (a === "--tenant-class") out.tenantClass = argv[++i];
    else if (a === "--max-cycles") out.maxCycles = Number(argv[++i]);
    else if (a === "--stamp") out.stamp = argv[++i];
    else if (a === "--stanza") out.stanza = argv[++i];
    else if (a === "--snapshot-label") out.snapshotLabel = argv[++i];
    else if (a === "--pgbackrest-exec") out.pgbackrestExec = argv[++i];
    else if (a === "--validate-snapshot") out.validateSnapshot = true;
    else if (a === "--no-validate-snapshot") out.validateSnapshot = false;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--confirm") out.confirm = true;
    else fail(`orchestrate: unknown arg ${a}`);
  }
  return out;
}

function fail(msg, code = 2) {
  console.error(`orchestrate: ${msg}`);
  process.exit(code);
}
function req(args, name, flag) {
  if (!args[name]) fail(`missing required --${flag}`);
  return args[name];
}

// ── structured timestamped step log ─────────────────────────────────────────────────────
const STEPS = [];
function ts() {
  return new Date().toISOString();
}
function step(name, status, detail) {
  const rec = { at: ts(), step: name, status, ...(detail ? { detail } : {}) };
  STEPS.push(rec);
  const icon = status === "ok" ? "✅" : status === "fail" ? "❌" : status === "skip" ? "⏭" : "▶";
  console.log(`[${rec.at}] ${icon} ${name}${detail ? ` — ${detail}` : ""}`);
  return rec;
}

/** Spawn a child (tsx script or npx) inheriting stdio; resolve {code} (never rejects). */
function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    if (opts.capture) {
      child.stdout.on("data", (d) => {
        stdout += d;
        process.stdout.write(d);
      });
      child.stderr.on("data", (d) => {
        stderr += d;
        process.stderr.write(d);
      });
    }
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (e) => {
      console.error(`orchestrate: failed to spawn ${cmd} — ${e?.stack ?? e}`);
      resolve({ code: 1, stdout, stderr });
    });
  });
}

function tsx(script, scriptArgs, opts) {
  return run("npx", ["tsx", path.join(__dirname, script), ...scriptArgs], opts);
}

async function main() {
  const args = parseArgs(process.argv);

  // ── validate ──
  const org = req(args, "org", "org");
  const slug = req(args, "slug", "slug");
  const source = req(args, "source", "source");
  const target = req(args, "target", "target");
  const scratch = req(args, "scratch", "scratch");
  const shadow = req(args, "shadow", "shadow");
  const dump = req(args, "dump", "prod-schema-dump");
  const state = req(args, "state", "state");
  const proxyAdmin = req(args, "proxyAdmin", "proxy-admin");
  const v1 = args.v1 ?? "cutover-v1:80";
  const v2 = args.v2 ?? "cutover-v2:80";
  const stamp = args.stamp ?? ts();
  // Tenant class drives the gov exposability sign-off gate. DEFAULT "commercial" (the
  // gate is then a no-op pass) so existing commercial runs are UNAFFECTED; a gov flip
  // MUST pass --tenant-class gov, which arms the sign-off gate (fail-closed).
  const tenantClass = args.tenantClass ?? "commercial";
  // Pre-flip snapshot capture (Step 5b). The named restore point label defaults to a
  // per-tenant, deterministic name. The stanza is the pgBackRest stanza ("cosmos").
  const stanza = args.stanza ?? "cosmos";
  const snapshotLabel = args.snapshotLabel ?? `cutover-${slug}-preflip`;
  // --pgbackrest-exec is the command prefix that runs pgBackRest against the TARGET cluster
  // (e.g. "sudo docker compose exec -T -u postgres cosmos-postgres"). When set, the capture
  // also triggers an incr backup; when absent the restore point + LSN/time alone is the target.
  const pgbackrestExec = args.pgbackrestExec ?? null;
  // Validate the captured point by restoring it into a SCRATCH cluster (the drill) before the
  // flip. Default: ON when --pgbackrest-exec is configured (the drill needs the pgbackrest
  // stack), OFF otherwise. Explicit --validate-snapshot / --no-validate-snapshot override.
  const validateSnapshot = args.validateSnapshot ?? Boolean(pgbackrestExec);

  if (!UUID_RE.test(org)) fail(`--org ${org} is not a UUID`);
  if (!SLUG_RE.test(slug)) fail(`--slug ${slug} is not a path-safe slug`);
  if (!existsSync(dump)) fail(`--prod-schema-dump not found: ${dump}`);
  if (!TENANT_CLASSES.has(tenantClass)) fail(`--tenant-class must be "gov" or "commercial" (got "${tenantClass}")`);
  if (args.confirm && args.dryRun) fail("pass EITHER --confirm OR --dry-run, not both");
  if (!Number.isInteger(args.maxCycles) || args.maxCycles < 1) fail(`--max-cycles must be a positive integer`);
  const confirm = args.confirm; // dry-run is the DEFAULT unless --confirm is explicitly given.

  // The gov exposability sign-off gate — evaluated up-front (read-only). For a gov tenant
  // this is the human-reviewed + leak-tested approval of the EXACT field-level default-deny
  // exposability map (bound to its hash). FAIL ⇒ a gov flip is BLOCKED (fail-closed). For a
  // commercial tenant it always passes (no sign-off required). It touches no proxy/DB state.
  const govGate = requireExposabilitySignoff(slug, tenantClass, loadSignoffFromDisk);

  const proxy = new ProxyControl({
    adminUrl: proxyAdmin,
    upstreams: { v1, v2 },
    log: (m) => console.log(`[${ts()}]    ${m}`),
  });

  // ── banner ──
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  COSMOS v2 — PER-TENANT CUTOVER ORCHESTRATOR (§9.4)");
  console.log(`  org ${org}  slug "${slug}"  @ ${stamp}`);
  console.log(`  MODE: ${confirm ? "CONFIRM (will EXECUTE)" : "DRY-RUN (default — touches NOTHING)"}`);
  console.log("  BUILD-ONLY / SYNTHETIC-TEST ONLY — never against a real prod/tenant.");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  source       : ${redact(source)}`);
  console.log(`  target(owner): ${redact(target)}`);
  console.log(`  scratch      : ${redact(scratch)}`);
  console.log(`  shadow       : ${redact(shadow)}`);
  console.log(`  prod dump    : ${dump}`);
  console.log(`  state        : ${state}`);
  console.log(`  proxy admin  : ${proxyAdmin}`);
  console.log(`  upstreams    : v1=${v1}  v2=${v2}`);
  console.log(`  tenant-class : ${tenantClass}`);
  console.log(`  max-cycles   : ${args.maxCycles}`);
  console.log(`  snapshot     : label "${snapshotLabel}"  stanza "${stanza}"`);
  console.log(`  snapshot bkup: ${pgbackrestExec ? `incr via "${pgbackrestExec}"` : "none (restore point + LSN/time only)"}`);
  console.log(`  validate snap: ${validateSnapshot ? "YES (restore-to-point drill into scratch before flip)" : "no"}`);
  console.log("");
  console.log(
    `  GOV EXPOSABILITY GATE: ${govGate.ok ? "✅ PASS" : "❌ FAIL"} — ${govGate.reason}`,
  );
  console.log(`  current exposability hash: ${govGate.currentHash}`);
  console.log("");

  // The planned sequence (printed always; in dry-run it's the WHOLE output).
  const govGateLine =
    tenantClass === "gov"
      ? `0. GOV EXPOSABILITY SIGN-OFF GATE (gov tenant): ${govGate.ok ? "ALLOWED — valid sign-off" : "BLOCKED — " + govGate.reason}`
      : `0. gov exposability sign-off gate: N/A (commercial tenant — not applicable)`;
  // The exact, precise PITR restore command the rollback WOULD emit for this run's captured
  // point. Built from the resolved label/stanza so the dry-run plan shows the operator EXACTLY
  // what they'd run (it is DESTRUCTIVE + operator-gated; the orchestrator never auto-runs it).
  const plannedRestoreCmd = restoreCommandsForRecord(
    {
      label: snapshotLabel,
      lsn: null,
      restorePointTime: "<captured restorePointTime>",
      stanza,
      timeline: null,
      capturedAt: stamp,
    },
    { delta: true, promote: true },
  ).named;
  const PLAN = [
    govGateLine,
    "1. parity-gate precheck (abort on fail — no freeze yet)",
    `2. soak loop (soak-sync until 0 upserts, ≤ ${args.maxCycles} cycles)`,
    `3. FREEZE org "${slug}" at the proxy (writes ⇒ 405, reads pass)`,
    "4. reconcile-org (final force-exact import + delete-extras + orphan probe)",
    "5. VERIFY GATE (verify-org — any failure ⇒ ROLLBACK)",
    `5b. CAPTURE pre-flip restore point "${snapshotLabel}" on the TARGET (snapshot-capture → state.snapshot)` +
      (pgbackrestExec ? " + incr pgBackRest backup" : ""),
    validateSnapshot
      ? `5c. VALIDATE: restore-to-point-drill.sh --target-name "${snapshotLabel}" into a SCRATCH cluster (prove rollback works)`
      : `5c. validate snapshot: SKIPPED (pass --validate-snapshot to run the restore-to-point drill)`,
    `6. FLIP: setOrgUpstream("${slug}", "v2")`,
    `7. UNFREEZE org "${slug}" (writes resume, served by v2)`,
    "ROLLBACK on any failure at/after freeze: setOrgUpstream(v1) + unfreeze (the EXECUTED, non-destructive rollback) + exit non-zero",
    `   then EMIT the precise DESTRUCTIVE + operator-gated PITR restore command for the captured point (NOT auto-run):`,
    `     ${plannedRestoreCmd}`,
  ];

  if (!confirm) {
    console.log("── DRY-RUN PLAN (no step is executed; re-run with --confirm to EXECUTE) ──");
    for (const p of PLAN) console.log(`   ${p}`);
    console.log("");
    // Record the gov-gate outcome as a STEP so the dry-run report machine-line carries it.
    if (tenantClass === "gov") {
      step(
        "gov exposability gate",
        govGate.ok ? "ok" : "fail",
        govGate.ok ? "ALLOWED (valid sign-off)" : `BLOCKED — ${govGate.reason}`,
      );
      if (!govGate.ok) {
        console.log(
          `   NOTE: under --confirm this gov flip would be ABORTED before any freeze (fail-closed).`,
        );
      }
    }
    step("dry-run", "skip", "plan printed; nothing touched");
    printReport(true);
    process.exit(0);
  }

  // ════════════════ EXECUTE (--confirm) ════════════════
  let frozen = false; // becomes true once we've frozen; gates the rollback path.
  let capturedSnapshot = null; // the captured pre-flip restore-point record (Step 5b) for rollback.

  try {
    // ── 0. GOV EXPOSABILITY SIGN-OFF GATE (gov only) — BEFORE any state is touched. ──
    // A gov flip requires a human-reviewed + leak-tested sign-off bound to the CURRENT
    // exposability-map hash. FAIL ⇒ ABORT here (no parity run, no freeze ⇒ nothing to roll
    // back). Commercial tenants pass automatically (the gate is a no-op for them).
    step("gov exposability gate", "run", `tenant-class ${tenantClass}`);
    if (!govGate.ok) {
      step("gov exposability gate", "fail", govGate.reason);
      console.error(
        "\norchestrate: GOV EXPOSABILITY SIGN-OFF GATE FAILED — aborting BEFORE any freeze. " +
          "Nothing to roll back. The gov flip is BLOCKED until a valid sign-off (matching the " +
          "current map hash, leakTestPassed) exists at " +
          `compliance/exposability/signoff/${slug}.json.`,
      );
      printReport(false);
      process.exit(1);
    }
    step("gov exposability gate", "ok", tenantClass === "gov" ? "valid sign-off" : "N/A (commercial)");

    // ── 1. PARITY-GATE PRECHECK (no proxy state yet ⇒ a fail just aborts) ──
    step("parity-gate precheck", "run");
    const parity = await tsx("parity-gate.mjs", [
      "--prod-schema-dump", dump,
      "--scratch-url", scratch,
      "--shadow-url", shadow,
      "--stamp", stamp,
      "--no-write", // precheck: do not (re)write the provenance baseline from the orchestrator
    ]);
    if (parity.code !== 0) {
      step("parity-gate precheck", "fail", `exit ${parity.code}`);
      console.error("\norchestrate: PARITY GATE FAILED — aborting BEFORE any freeze. Nothing to roll back.");
      printReport(false);
      process.exit(1);
    }
    step("parity-gate precheck", "ok");

    // ── 2. SOAK loop until caught up (0 upserts) or --max-cycles ──
    step("soak loop", "run", `≤ ${args.maxCycles} cycles`);
    let caughtUp = false;
    let cyclesRun = 0;
    for (let c = 1; c <= args.maxCycles; c++) {
      cyclesRun = c;
      const cy = await tsx("soak-sync.mjs", [
        "--source", source, "--target", target, "--org", org, "--state", state, "--stamp", stamp,
      ], { capture: true });
      if (cy.code !== 0) {
        step("soak loop", "fail", `cycle ${c} exit ${cy.code}`);
        console.error("\norchestrate: SOAK cycle FAILED — aborting BEFORE freeze. Nothing to roll back.");
        printReport(false);
        process.exit(1);
      }
      const upserts = parseSoakUpserts(cy.stdout);
      console.log(`[${ts()}]    soak cycle ${c}: upserts=${upserts ?? "?"}`);
      if (upserts === 0) {
        caughtUp = true;
        break;
      }
    }
    step("soak loop", caughtUp ? "ok" : "ok", caughtUp ? `caught up after ${cyclesRun} cycle(s)` : `hit --max-cycles ${args.maxCycles} (proceeding under freeze; the final reconcile is exact)`);

    // ── 3. FREEZE (from here on, ANY failure ⇒ rollback) ──
    step("freeze", "run", `org "${slug}"`);
    await proxy.freezeOrg(slug);
    frozen = true;
    const fs = await proxy.getOrgState(slug);
    if (!fs.frozen) throw new Error(`freeze did not take effect (proxy state: ${JSON.stringify(fs)})`);
    step("freeze", "ok", `proxy state ${JSON.stringify(fs)}`);

    // ── 4. RECONCILE (final, under freeze: force-exact + delete-extras + orphan probe + verify) ──
    step("reconcile-org", "run");
    const recon = await tsx("reconcile-org.mjs", [
      "--source", source, "--target", target, "--org", org, "--stamp", stamp,
    ]);
    if (recon.code !== 0) throw new Error(`reconcile-org exited ${recon.code}`);
    step("reconcile-org", "ok");

    // ── 5. VERIFY GATE (explicit — the canonical rollback trigger) ──
    step("verify gate", "run");
    const verify = await tsx("verify-org.mjs", ["--source", source, "--target", target, "--org", org]);
    if (verify.code !== 0) throw new Error(`verify-org GATE FAILED (exit ${verify.code}) — do NOT flip`);
    step("verify gate", "ok", "v2 exactly matches the frozen source");

    // ── 5b. CAPTURE the pre-flip restore point on the TARGET (the precise data-rollback target) ──
    // This runs AFTER verify (v2 is exactly the frozen source) and BEFORE the flip, so the
    // captured point is the exact pre-flip state. The ONLY write is a WAL restore-point record.
    step("snapshot capture", "run", `label "${snapshotLabel}" on the target`);
    const captureArgs = [
      "--db", target,
      "--label", snapshotLabel,
      "--stamp", stamp,
      "--state", state,
      "--stanza", stanza,
    ];
    if (pgbackrestExec) captureArgs.push("--pgbackrest-exec", pgbackrestExec);
    const capture = await tsx("snapshot-capture.mjs", captureArgs);
    if (capture.code !== 0) throw new Error(`snapshot-capture FAILED (exit ${capture.code}) — do NOT flip without a pre-flip restore point`);
    // Read back the recorded snapshot from --state so rollback can emit the exact restore command.
    try {
      const stTxt = await readFile(state, "utf8");
      capturedSnapshot = parseSnapshotRecord(JSON.parse(stTxt).snapshot);
    } catch (e) {
      throw new Error(`snapshot-capture wrote no readable .snapshot into ${state}: ${e?.message ?? e}`);
    }
    step("snapshot capture", "ok", `restore point "${capturedSnapshot.label}" lsn=${capturedSnapshot.lsn ?? "n/a"} backup=${capturedSnapshot.backupLabel ?? "none"}`);

    // ── 5c. VALIDATE (optional): restore the captured point into a SCRATCH cluster (the drill) ──
    // Proves the rollback WOULD work before the flip. Uses a SCRATCH cluster ONLY — the live one
    // is never touched. Gated by --validate-snapshot (default on when pgbackrest is configured).
    if (validateSnapshot) {
      step("snapshot validate", "run", `restore-to-point drill (scratch) → target-name "${capturedSnapshot.label}"`);
      const drill = await run("bash", [
        path.join(__dirname, "..", "dsop", "restore-to-point-drill.sh"),
        "--target-name", capturedSnapshot.label,
        "--state", state,
      ], { capture: true });
      if (drill.code !== 0 || !/RESTORE-TO-POINT: PASS/.test(drill.stdout)) {
        throw new Error(`snapshot validate FAILED (exit ${drill.code}) — the captured restore point is NOT restorable; do NOT flip`);
      }
      step("snapshot validate", "ok", "RESTORE-TO-POINT: PASS (scratch cluster restored to the point)");
    } else {
      step("snapshot validate", "skip", "pass --validate-snapshot to drill the captured point into a scratch cluster");
    }

    // ── 6. FLIP ──
    step("flip", "run", `setOrgUpstream("${slug}", "v2")`);
    await proxy.setOrgUpstream(slug, "v2");
    const flipState = await proxy.getOrgState(slug);
    if (flipState.upstream !== "v2") throw new Error(`flip did not take effect (proxy state: ${JSON.stringify(flipState)})`);
    step("flip", "ok", `proxy state ${JSON.stringify(flipState)}`);

    // ── 7. UNFREEZE ──
    step("unfreeze", "run");
    await proxy.unfreezeOrg(slug);
    const finalState = await proxy.getOrgState(slug);
    if (finalState.frozen) throw new Error(`unfreeze did not take effect (proxy state: ${JSON.stringify(finalState)})`);
    step("unfreeze", "ok", `proxy state ${JSON.stringify(finalState)}`);

    console.log("\n══════════════════════════════════════════════════════════════════════");
    console.log(`  CUTOVER COMPLETE — org "${slug}" now served by v2, writes resumed.`);
    console.log("══════════════════════════════════════════════════════════════════════");
    printReport(true);
    process.exit(0);
  } catch (err) {
    step("FAILURE", "fail", String(err?.message ?? err));
    console.error(`\norchestrate: ${err?.stack ?? err}`);
    if (frozen) {
      await rollback(proxy, slug, capturedSnapshot, { stanza, snapshotLabel, stamp });
    } else {
      console.error("orchestrate: failure occurred BEFORE freeze — no proxy state to roll back.");
    }
    printReport(false);
    process.exit(1);
  }
}

/**
 * ROLLBACK — route the org back to v1 + unfreeze, so it is NEVER left frozen or half-flipped.
 * This (re-route to v1 + unfreeze) is the EXECUTED, NON-DESTRUCTIVE primary rollback — v1 was
 * not mutated by the cutover (§9.3-5), so it is the live data rollback.
 *
 * Then EMIT the precise, DESTRUCTIVE, OPERATOR-GATED PITR restore command for the captured
 * pre-flip restore point — needed ONLY if v2 already took post-flip writes. The orchestrator
 * NEVER auto-runs this restore (a DB restore is destructive); it only emits the exact command
 * for an operator to run deliberately. The proxy ops are best-effort + idempotent; even if one
 * throws we still emit the restore command (it's the authoritative data rollback target).
 *
 * @param capturedSnapshot the SnapshotRecord captured at Step 5b (or null if the failure
 *   happened before capture, e.g. reconcile/verify failed — then no exact point exists yet).
 */
async function rollback(proxy, slug, capturedSnapshot, fallback) {
  step("ROLLBACK", "run", `route org "${slug}" → v1 + unfreeze (executed, non-destructive)`);
  let proxyOk = true;
  try {
    await proxy.setOrgUpstream(slug, "v1");
    step("rollback: setOrgUpstream v1", "ok");
  } catch (e) {
    proxyOk = false;
    step("rollback: setOrgUpstream v1", "fail", String(e?.message ?? e));
  }
  try {
    await proxy.unfreezeOrg(slug);
    step("rollback: unfreeze", "ok");
  } catch (e) {
    proxyOk = false;
    step("rollback: unfreeze", "fail", String(e?.message ?? e));
  }
  try {
    const s = await proxy.getOrgState(slug);
    step("rollback: verify proxy state", s.upstream === "v1" && !s.frozen ? "ok" : "fail", JSON.stringify(s));
  } catch {
    /* already counted */
  }

  // Build the PRECISE restore commands from the captured record when we have one (failure was
  // AT/after capture); otherwise the failure was before capture (reconcile/verify) — no exact
  // point was stamped, so emit the documented placeholder form (still operator-gated).
  const haveExact = capturedSnapshot !== null && capturedSnapshot !== undefined;
  let namedCmd;
  let timeCmd;
  if (haveExact) {
    const cmds = restoreCommandsForRecord(capturedSnapshot, { delta: true, promote: true });
    namedCmd = cmds.named;
    timeCmd = cmds.time;
  } else {
    namedCmd =
      `pgbackrest --stanza=${fallback.stanza} --type=name --target=${fallback.snapshotLabel} ` +
      `--target-action=promote --delta restore  # (NOTE: failure occurred BEFORE the restore point ` +
      `was captured — no exact pre-flip point exists; capture one or use a prior pgBackRest backup)`;
    timeCmd = `pgbackrest --stanza=${fallback.stanza} --type=time --target="<PRE-FLIP timestamp>" --target-action=promote --delta restore`;
  }

  console.error("\n══════════════════════════════════════════════════════════════════════");
  console.error("  ROLLBACK — DATA RESTORE (DESTRUCTIVE — OPERATOR-GATED — NOT auto-run):");
  console.error("══════════════════════════════════════════════════════════════════════");
  console.error(`  The proxy has been routed back to v1${proxyOk ? "" : " (⚠ a proxy op FAILED — verify manually)"}.`);
  console.error("  That re-route + unfreeze IS the EXECUTED, non-destructive rollback: v1 (the source)");
  console.error("  was NOT mutated by the cutover and its columns are kept intact per §9.3-5, so v1 IS");
  console.error("  the live data rollback — NO restore is needed if v2 never took post-flip writes.");
  console.error("");
  if (haveExact) {
    console.error(`  A precise PRE-FLIP restore point WAS captured: "${capturedSnapshot.label}"`);
    console.error(`    (lsn=${capturedSnapshot.lsn ?? "n/a"}, restorePointTime=${capturedSnapshot.restorePointTime}, ` +
      `backup=${capturedSnapshot.backupLabel ?? "none"}, stanza=${capturedSnapshot.stanza})`);
  } else {
    console.error("  ⚠ The failure occurred BEFORE a restore point was captured (reconcile/verify) —");
    console.error("    no EXACT pre-flip point exists. The command below is the documented form.");
  }
  console.error("  If v2 DID receive writes post-flip, an operator (NOT this script) restores the TARGET");
  console.error("  (v2) to the PRE-FLIP point with the EXACT command below. VALIDATE it into a scratch");
  console.error("  cluster first (restore-to-point-drill.sh) — then it overwrites the live datadir:");
  console.error("");
  console.error("    # 1. (validate first) scripts/dsop/restore-to-point-drill.sh \\");
  console.error(`    #        --target-name ${haveExact ? capturedSnapshot.label : fallback.snapshotLabel}`);
  console.error("    # 2. (DESTRUCTIVE) on the TARGET cluster — operator runs this by hand:");
  console.error(`    #      ${namedCmd}`);
  console.error("    #    (fallback by time:)");
  console.error(`    #      ${timeCmd}`);
  console.error("    # 3. Re-run parity/soak/verify before attempting the cutover again.");
  console.error("══════════════════════════════════════════════════════════════════════");
  // Also emit the precise restore command as a STEP (→ stdout + the ORCHESTRATE_REPORT) so the
  // instruction is captured authoritatively even when stderr interleaves with child output.
  step(
    "rollback: data-restore (DESTRUCTIVE, operator-gated, NOT auto-run)",
    "ok",
    `${haveExact ? "precise PITR restore for captured point" : "documented PITR restore (no exact point captured)"}: ${namedCmd}`,
  );
}

/** Parse the SOAK_SYNC_CYCLE machine line for this cycle's upsert count. */
function parseSoakUpserts(stdout) {
  const lines = stdout.split("\n").filter((l) => l.startsWith("SOAK_SYNC_CYCLE "));
  if (lines.length === 0) return null;
  try {
    const obj = JSON.parse(lines[lines.length - 1].slice("SOAK_SYNC_CYCLE ".length));
    return typeof obj.upserted === "number" ? obj.upserted : null;
  } catch {
    return null;
  }
}

function printReport(ok) {
  console.log("\nORCHESTRATE_REPORT " + JSON.stringify({ ok, steps: STEPS }));
}

function redact(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}

main().catch((e) => {
  console.error(`orchestrate: unexpected error — ${e?.stack ?? e}`);
  process.exit(2);
});
