// scripts/acceptance/handle-resolver-acceptance.ts
//
// Docker acceptance harness for the opaque-handle resolver. Runs INSIDE the
// cosmos-v2-migrate:dev image (full src/ + tsx + prisma + the real vault key) on
// the compose network, against the DEPLOYED postgres + the just-applied
// 20260606100000_egress_handles migration. Exercises the threat-model invariants
// end-to-end with the REAL handles.ts + projection.augmentWithHandles + vault:
//
//   MINT      a withheld gov entity result → augmentWithHandles puts an h:… TOKEN
//             (NOT the CUI) in the model view; a sealed egress_handles row exists.
//   RESOLVE   resolveHandlesDeep substitutes the token in a later tool's args with
//             the REAL value (proves the executor would get the real value).
//   CROSS-CONV the SAME token under a DIFFERENT conversationId does NOT resolve.
//   FLAG-OFF  is verified separately (the loop reads EGRESS_HANDLES_ENABLED; the
//             vitest red-team suite asserts parity — here we assert the store/
//             projection primitives directly).
//
// Exits non-zero on any failed assertion. Prints a labelled PASS/▢ line per check.
import { mintHandle, resolveHandle, resolveHandlesDeep } from "../../src/lib/ai/egress/handles";
import { augmentWithHandles, projectResult } from "../../src/lib/ai/egress/projection";
import { projectForModel } from "../../src/lib/ai/egress/gate";
import { effectiveCeiling, maxByRank } from "../../src/lib/classification/effective";
import { isWithheld } from "../../src/lib/ai/egress/types";
import { prisma } from "../../src/lib/db/client";
import crypto from "node:crypto";

const CUI = "CUI//SP Sentinel kill-chain timeline 2026 — withheld";
let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}

async function main() {
  const convA = "accept-conv-A-" + Date.now();
  const convB = "accept-conv-B-" + Date.now();

  // ── MINT (via the real projection augmentation, as the loop does on withhold) ──
  const source = { count: 1, items: [{ id: "w1", title: CUI, status: "DONE", columnKey: "done" }] };
  const modelView = projectResult(source, "work_item"); // structural-only (no CUI)
  const { modelView: augmented, minted } = await augmentWithHandles(modelView, source, "work_item", convA, "CUI");
  const mvStr = JSON.stringify(augmented);
  const item0 = (augmented as { items: Array<Record<string, unknown>> }).items[0];
  const token = item0.title as string;

  check("MINT: 1 handle minted for work_item.title", minted === 1, `minted=${minted}`);
  check("MINT: model view contains an h:… token", /^h:[A-Za-z0-9_-]{24}$/.test(token), `token=${token}`);
  check("MINT: model view does NOT contain the CUI value", !mvStr.includes("Sentinel") && !mvStr.includes("CUI//SP"));
  check("MINT: structural id survives in the model view", item0.id === "w1");

  // sealed row exists in the DB and value_enc is an envelope, not plaintext.
  const row = await prisma.egressHandle.findUnique({ where: { token } });
  check("MINT: a sealed egress_handles row exists for the token", !!row);
  check("MINT: value_enc is a v2.<kid> vault envelope (NOT plaintext CUI)",
    !!row && row.valueEnc.startsWith("v2.") && !row.valueEnc.includes("Sentinel"),
    row ? row.valueEnc.slice(0, 24) + "…" : "(no row)");
  check("MINT: row conversationId is conversation A", !!row && row.conversationId === convA);
  check("MINT: row metadata is non-CUI (entity_type/field_name only)",
    !!row && row.entityType === "work_item" && row.fieldName === "title");

  // ── RESOLVE (in-boundary, same conversation) — proves the executor gets the real value ──
  const toolArgs = { title: "Filed from work item A", content: token, nested: { tags: ["x", token] } };
  const { resolved, count, maxCeiling } = await resolveHandlesDeep(toolArgs, convA);
  const r = resolved as typeof toolArgs;
  check("RESOLVE: 2 handle occurrences resolved in the tool args", count === 2, `count=${count}`);
  check("RESOLVE: the executor would receive the REAL CUI value (whole-string arg)", r.content === CUI);
  check("RESOLVE: the nested handle also resolves to the real value", r.nested.tags[1] === CUI);
  check("RESOLVE: a single resolveHandle returns the real value in-conversation", (await resolveHandle(convA, token))?.value === CUI);
  // C1: the resolve reports the mint-time ceiling so the loop can re-gate at ≥ it.
  check("RESOLVE: maxCeiling = the mint-time ceiling (CUI)", maxCeiling === "CUI", `maxCeiling=${maxCeiling}`);
  check("RESOLVE: a single resolveHandle round-trips the mint ceiling", (await resolveHandle(convA, token))?.ceiling === "CUI");

  // ── CROSS-CONVERSATION ISOLATION — the SAME token must NOT resolve in conv B ──
  const single = await resolveHandle(convB, token);
  check("CROSS-CONV: resolveHandle(convB, token) returns null (scope enforced)", single === null);
  const { resolved: rB, count: cB } = await resolveHandlesDeep({ content: token }, convB);
  check("CROSS-CONV: deep-resolve in conv B substitutes NOTHING", cB === 0);
  check("CROSS-CONV: the executor in conv B would see the LITERAL token, never the CUI",
    (rB as { content: string }).content === token && !JSON.stringify(rB).includes("Sentinel"));

  // ── EXACT-MATCH — an embedded handle is NOT substituted ──
  const { count: cEmbed, resolved: rEmbed } = await resolveHandlesDeep({ content: `see ${token} here` }, convA);
  check("EXACT-MATCH: a handle embedded in a larger string is NOT substituted",
    cEmbed === 0 && !JSON.stringify(rEmbed).includes("Sentinel"));

  // ── FABRICATED TOKEN — a guessed token does not resolve ──
  const fake = "h:" + "A".repeat(24);
  check("FABRICATED: a guessed/never-minted token resolves to null", (await resolveHandle(convA, fake)) === null);

  // ── DEFAULT-DENY — a non-HANDLEABLE entity (project) mints nothing ──
  const projSource = { count: 1, projects: [{ id: "p1", name: "CUI Project Name", archived: false }] };
  const { minted: projMint } = await augmentWithHandles(projectResult(projSource, "project"), projSource, "project", convA, "CUI");
  check("DEFAULT-DENY: a non-HANDLEABLE entity (project.name) mints NO handle", projMint === 0);

  // ── C1 CONTAINMENT (the Critical CUI-exfiltration bug, now CLOSED) ─────────────
  // Attack (commercial tenant, DIVERGENT ceiling): org ceiling = UNCLASSIFIED but a
  // per-project ceiling = CUI. The model mints a handle on a project-P (CUI) turn,
  // then resolves+echoes it on a turn with NO projectId — which re-gates at the
  // (lower) ORG ceiling. PRE-FIX: commercial + below-FOUO + unmarked ⇒ EXPOSED ⇒ the
  // real CUI reaches the model. POST-FIX: resolving the handle folds its mint-time
  // ceiling (CUI) back into the result ceiling (max-by-rank) BEFORE projectForModel,
  // so the result is WITHHELD for BOTH tenants. This drives the EXACT loop pipeline
  // (real mintHandle → resolveHandlesDeep → maxByRank → projectForModel) with the
  // real DB-backed effectiveCeiling for the no-projectId/org-UNCLASSIFIED echo turn.
  const convC1 = "accept-conv-C1-" + Date.now();
  // UNMARKED CUI: real controlled content with NO marking token (the marking-DLP gate
  // would withhold a marked value on its own — using unmarked content proves it is the
  // CEILING fold, not the marking detector, that closes C1).
  const UNMARKED_CUI = "Sentinel program kill-chain timeline 2026 — sensor fusion exfil path";
  // Echo-turn org has NO data_classifications rows ⇒ effectiveCeiling = UNCLASSIFIED
  // (the attacker's low per-turn ceiling). Use a random orgId so the row set is empty.
  const echoOrgId = crypto.randomUUID();
  const echoOrgCeiling = await effectiveCeiling(echoOrgId, undefined); // expect UNCLASSIFIED
  check("C1: the echo turn's org ceiling is UNCLASSIFIED (the low re-gate ceiling)", echoOrgCeiling === "UNCLASSIFIED", `got=${echoOrgCeiling}`);

  // MINT turn (project P, ceiling=CUI): a work-item title withheld at CUI → a handle.
  const c1Source = { count: 1, items: [{ id: "wC1", title: UNMARKED_CUI, status: "DONE" }] };
  const c1View = projectResult(c1Source, "work_item");
  await augmentWithHandles(c1View, c1Source, "work_item", convC1, "CUI"); // bind CUI to the handle
  const c1Token = ((c1View as { items: Array<Record<string, unknown>> }).items[0].title) as string;
  check("C1: mint produced an h:… token (not the CUI)", /^h:[A-Za-z0-9_-]{24}$/.test(c1Token) && c1Token !== UNMARKED_CUI);

  // ECHO turn (NO projectId): the model carries the token into a tool whose executor
  // would echo the resolved arg back. resolveHandlesDeep substitutes the REAL CUI for
  // the executor (in-boundary action still works) AND reports maxCeiling=CUI.
  const { resolved: c1Resolved, maxCeiling: c1MaxCeiling } = await resolveHandlesDeep({ controlId: c1Token, status: "IMPLEMENTED" }, convC1);
  check("C1: the EXECUTOR receives the REAL CUI value in-boundary (action works)", (c1Resolved as { controlId: string }).controlId === UNMARKED_CUI);
  check("C1: resolve reports maxCeiling = CUI (mint ceiling bound to the handle)", c1MaxCeiling === "CUI", `maxCeiling=${c1MaxCeiling}`);

  // The executor's RESULT echoes the resolved CUI (the compliance.ts error path).
  const echoedOutput = { error: `No compliance control '${(c1Resolved as { controlId: string }).controlId}' found in this org.` };
  check("C1: (sanity) the executor result string DOES contain the CUI before gating", echoedOutput.error.includes(UNMARKED_CUI));

  // RE-GATE exactly as the loop now does: fold the resolved ceiling into the result
  // ceiling, THEN projectForModel under the COMMERCIAL tenant.
  const c1Ceiling = maxByRank(echoOrgCeiling, c1MaxCeiling); // expect CUI
  check("C1: the re-gate ceiling is forced up to CUI (max-by-rank fold)", c1Ceiling === "CUI", `ceiling=${c1Ceiling}`);
  const c1Ctx = { orgId: echoOrgId, conversationId: convC1, turn: 1, tenantClass: "commercial" as const, mode: "enforced" as const };
  const c1Projected = projectForModel(echoedOutput, c1Ctx, { valueKind: "error", toolName: "update_compliance_control", ceiling: c1Ceiling });
  check("C1: the model-facing result is WITHHELD (commercial tenant, CUI-forced ceiling)", c1Projected.decision.exposed === false && isWithheld(c1Projected.modelValue));
  check("C1: the model NEVER receives the CUI value via the echo path", !JSON.stringify(c1Projected.modelValue).includes(UNMARKED_CUI) && !JSON.stringify(c1Projected.modelValue).includes("Sentinel"));

  // Counter-proof that the fix is what closes it: WITHOUT the fold, the SAME echo
  // result under the org UNCLASSIFIED ceiling on commercial would have been EXPOSED.
  const c1Unfixed = projectForModel(echoedOutput, c1Ctx, { valueKind: "error", toolName: "update_compliance_control", ceiling: echoOrgCeiling });
  check("C1: counter-proof — WITHOUT the ceiling fold the SAME result would have leaked (was exposed)", c1Unfixed.decision.exposed === true);

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL ACCEPTANCE CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
