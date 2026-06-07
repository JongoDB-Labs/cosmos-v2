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
//       [--max-cycles N]                  (soak loop cap; default 10) \
//       [--stamp <iso8601>]               (the run timestamp; a CLI arg like the other tools) \
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
//   6. FLIP — proxy-control.setOrgUpstream(slug, "v2"): the org's path now routes to v2.
//   7. UNFREEZE — proxy-control.unfreezeOrg(slug): writes resume, now served by v2.
//
// ROLLBACK (any failure AT or AFTER freeze): setOrgUpstream(slug,"v1") + unfreezeOrg(slug) so the
// org is NEVER left frozen or half-flipped; then print the documented snapshot-restore step (the
// data rollback is the pre-flip v1 snapshot — v1's columns are kept intact per §9.3-5) and exit
// NON-ZERO. A failure BEFORE freeze (parity/soak) simply aborts (no proxy state to undo).
//
// SAFE-BY-DEFAULT: --dry-run is the DEFAULT. It prints the full plan + the resolved args and
// touches NOTHING — no parity run, no soak, no freeze, no reconcile, no flip. Only --confirm
// executes. BUILD-ONLY / SYNTHETIC-TEST ONLY: never point --source/--target/--proxy-admin at a
// real production stack without docs/runbooks/cutover.md + explicit sign-off + live coordination.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyControl } from "./lib/proxy-control.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i; // a path-safe slug (the dashboard route token)
const DEFAULT_MAX_CYCLES = 10;

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
    else if (a === "--max-cycles") out.maxCycles = Number(argv[++i]);
    else if (a === "--stamp") out.stamp = argv[++i];
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

  if (!UUID_RE.test(org)) fail(`--org ${org} is not a UUID`);
  if (!SLUG_RE.test(slug)) fail(`--slug ${slug} is not a path-safe slug`);
  if (!existsSync(dump)) fail(`--prod-schema-dump not found: ${dump}`);
  if (args.confirm && args.dryRun) fail("pass EITHER --confirm OR --dry-run, not both");
  if (!Number.isInteger(args.maxCycles) || args.maxCycles < 1) fail(`--max-cycles must be a positive integer`);
  const confirm = args.confirm; // dry-run is the DEFAULT unless --confirm is explicitly given.

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
  console.log(`  max-cycles   : ${args.maxCycles}`);
  console.log("");

  // The planned sequence (printed always; in dry-run it's the WHOLE output).
  const PLAN = [
    "1. parity-gate precheck (abort on fail — no freeze yet)",
    `2. soak loop (soak-sync until 0 upserts, ≤ ${args.maxCycles} cycles)`,
    `3. FREEZE org "${slug}" at the proxy (writes ⇒ 405, reads pass)`,
    "4. reconcile-org (final force-exact import + delete-extras + orphan probe)",
    "5. VERIFY GATE (verify-org — any failure ⇒ ROLLBACK)",
    `6. FLIP: setOrgUpstream("${slug}", "v2")`,
    `7. UNFREEZE org "${slug}" (writes resume, served by v2)`,
    "ROLLBACK on any failure at/after freeze: setOrgUpstream(v1) + unfreeze + print snapshot-restore + exit non-zero",
  ];

  if (!confirm) {
    console.log("── DRY-RUN PLAN (no step is executed; re-run with --confirm to EXECUTE) ──");
    for (const p of PLAN) console.log(`   ${p}`);
    console.log("");
    step("dry-run", "skip", "plan printed; nothing touched");
    printReport(true);
    process.exit(0);
  }

  // ════════════════ EXECUTE (--confirm) ════════════════
  let frozen = false; // becomes true once we've frozen; gates the rollback path.

  try {
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
      await rollback(proxy, slug);
    } else {
      console.error("orchestrate: failure occurred BEFORE freeze — no proxy state to roll back.");
    }
    printReport(false);
    process.exit(1);
  }
}

/**
 * ROLLBACK — route the org back to v1 + unfreeze, so it is NEVER left frozen or half-flipped.
 * Then print the documented data-rollback (snapshot-restore) instruction. The proxy ops are
 * best-effort and idempotent; even if one throws we still print the snapshot step (it's the
 * authoritative data rollback).
 */
async function rollback(proxy, slug) {
  step("ROLLBACK", "run", `route org "${slug}" → v1 + unfreeze`);
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

  console.error("\n══════════════════════════════════════════════════════════════════════");
  console.error("  ROLLBACK — DATA RESTORE (manual, documented):");
  console.error("══════════════════════════════════════════════════════════════════════");
  console.error(`  The proxy has been routed back to v1${proxyOk ? "" : " (⚠ a proxy op FAILED — verify manually)"}.`);
  console.error("  v1 (the source) was NOT mutated by the cutover and its columns are kept intact");
  console.error("  per §9.3-5, so v1 IS the live data rollback — no restore is needed if the org");
  console.error("  never started writing to v2. If v2 DID receive writes post-flip, restore the");
  console.error("  per-tenant data from the PRE-FLIP v1 snapshot:");
  console.error("");
  console.error("    # 1. Confirm the org is back on v1 at the proxy (done above).");
  console.error("    # 2. Restore the pre-flip snapshot of the TARGET (v2) org data, e.g. pgBackRest:");
  console.error("    #      pgbackrest --stanza=cosmos --type=time \\");
  console.error("    #        --target=\"<PRE-FLIP timestamp>\" --delta restore");
  console.error("    #    (or your snapshot tool's point-in-time restore to just before the flip).");
  console.error("    # 3. Re-run parity/soak/verify before attempting the cutover again.");
  console.error("══════════════════════════════════════════════════════════════════════");
  // Also emit the snapshot-restore as a STEP (→ stdout + the ORCHESTRATE_REPORT) so the
  // instruction is captured authoritatively even when stderr interleaves with child output.
  step(
    "rollback: data-restore (manual)",
    "ok",
    'restore the TARGET v2 org data from the PRE-FLIP v1 snapshot, e.g. ' +
      'pgbackrest --stanza=cosmos --type=time --target="<PRE-FLIP timestamp>" --delta restore',
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
