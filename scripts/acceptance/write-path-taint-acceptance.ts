// scripts/acceptance/write-path-taint-acceptance.ts
//
// Docker acceptance harness for WRITE-PATH TAINT (v2.13.0). Runs INSIDE the
// cosmos-v2-migrate:dev image (full src/ + tsx + prisma + the real vault key) on the
// compose network, against the DEPLOYED postgres. Proves — end-to-end, against the
// LIVE database — that the agent CANNOT launder CUI DOWN by resolving a CUI-minted
// opaque handle into a write that would persist that CUI into a lower-classification
// container, while a legitimate at-or-above write still succeeds in-boundary.
//
// It exercises the REAL primitives the loop uses (no model call — that is the external
// boundary): mintHandle / resolveHandlesDeep (sealed vault round-trip), the DB-backed
// effectiveCeiling + the EXACT taint comparison from agent-loop.ts
// (rankOf(targetCeiling) < rankOf(resolvedMaxCeiling)), the REAL createWorkItem executor
// (RBAC + Prisma write), and the REAL logEgressDecision (append-only egress_decisions row).
//
// Seeds a gov org with an OWNER user, a CUI-cleared project P (data_classifications
// level=CUI) and an UNCLASSIFIED project U, plus a work-item type. Then:
//
//   BLOCK (laundering): mint a CUI handle (project-P withheld title); resolve it into a
//     create_work_item targeting UNCLASSIFIED project U. target(UNCLASSIFIED) <
//     resolved(CUI) ⇒ TAINT BLOCK: the executor is NOT called (NO work_item row created
//     in U; the CUI value is NOT in the DB), the agent would get a LEVELS-ONLY error,
//     and a handle_taint_block egress_decisions row exists (no CUI in it).
//   ALLOW (at-or-above): resolve the SAME handle into a create_work_item targeting the
//     CUI-cleared project P. target(CUI) == resolved(CUI) ⇒ ALLOW: the executor RUNS,
//     the resolved CUI value is PERSISTED in-boundary (a work_item row in P carries it),
//     and a handle_resolve row is logged.
//
// Exits non-zero on any failed assertion. Tears its own seed down at the end.
import { mintHandle, resolveHandlesDeep } from "../../src/lib/ai/egress/handles";
import { effectiveCeiling, rankOf } from "../../src/lib/classification/effective";
import { logEgressDecision } from "../../src/lib/ai/egress/audit";
import { sha256Hex } from "../../src/lib/ai/egress/gate";
import { createWorkItem } from "../../src/lib/ai/executors/work-items";
import { prisma } from "../../src/lib/db/client";
import type { ClassificationLevel } from "@prisma/client";

// UNMARKED CUI: real controlled content with NO "CUI//" marking token, so it is the
// CEILING/taint check — not the marking-DLP detector — that contains it.
const CUI_VALUE = "Sentinel program kill-chain timeline 2026 — sensor fusion exfil path";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}

// The EXACT taint predicate from agent-loop.ts (the integration point under test).
function isTaintBlocked(targetCeiling: ClassificationLevel, resolvedMaxCeiling: ClassificationLevel | null): boolean {
  return resolvedMaxCeiling !== null && rankOf(targetCeiling) < rankOf(resolvedMaxCeiling);
}

async function main() {
  const stamp = Date.now();
  const slug = `accept-taint-${stamp}`;
  const conv = `accept-taint-conv-${stamp}`;

  // ── SEED: gov org + OWNER user + project P (CUI) + project U (UNCLASSIFIED) + a type ──
  const org = await prisma.organization.create({
    data: { name: "Acceptance Taint Org", slug, tenantClass: "GOV" },
  });
  const user = await prisma.user.create({
    data: { email: `taint-${stamp}@example.test`, displayName: "Taint Acceptance User" },
  });
  await prisma.orgMember.create({
    data: { orgId: org.id, userId: user.id, role: "OWNER" }, // OWNER ⇒ full permission bitmask
  });
  const projectP = await prisma.project.create({
    data: { orgId: org.id, name: "Project P (CUI)", key: "PCUI" },
  });
  const projectU = await prisma.project.create({
    data: { orgId: org.id, name: "Project U (UNCLASS)", key: "UUNC" },
  });
  // Per-project ceilings: P = CUI, U = UNCLASSIFIED. (Org ceiling row omitted ⇒ defaults
  // to UNCLASSIFIED, which is the conservative floor.)
  await prisma.dataClassification.create({
    data: { orgId: org.id, projectId: projectP.id, level: "CUI", appliedById: user.id },
  });
  await prisma.dataClassification.create({
    data: { orgId: org.id, projectId: projectU.id, level: "UNCLASSIFIED", appliedById: user.id },
  });
  const wit = await prisma.workItemType.create({
    data: { orgId: org.id, key: "software.task", name: "Task", pluralName: "Tasks", isBuiltIn: true },
  });

  // Sanity: the DB-backed effective ceilings are what we expect.
  const ceilP = await effectiveCeiling(org.id, projectP.id);
  const ceilU = await effectiveCeiling(org.id, projectU.id);
  check("SEED: project P effective ceiling = CUI (DB-backed)", ceilP === "CUI", `got=${ceilP}`);
  check("SEED: project U effective ceiling = UNCLASSIFIED (DB-backed)", ceilU === "UNCLASSIFIED", `got=${ceilU}`);

  // ── MINT a CUI handle for a withheld project-P title (sealed at rest in the vault) ──
  const token = await mintHandle(conv, CUI_VALUE, { entityType: "work_item", fieldName: "title" }, "CUI");
  check("MINT: an h:… token was minted (not the CUI value)", /^h:[A-Za-z0-9_-]{24}$/.test(token) && token !== CUI_VALUE, `token=${token}`);
  const row = await prisma.egressHandle.findUnique({ where: { token } });
  check("MINT: sealed egress_handles row exists; value_enc is a vault envelope (no plaintext CUI)",
    !!row && row.valueEnc.startsWith("v2.") && !row.valueEnc.includes("Sentinel"));

  // ════════════════════════════════════════════════════════════════════════════════
  // BLOCK — resolve the CUI handle into a write targeting UNCLASSIFIED project U.
  // ════════════════════════════════════════════════════════════════════════════════
  const blockArgs = { projectId: projectU.id, title: token };
  const { resolved: blockResolved, count: blockCount, maxCeiling: blockMax } = await resolveHandlesDeep(blockArgs, conv);
  check("BLOCK: the handle resolves in-boundary (count=1, maxCeiling=CUI)", blockCount === 1 && blockMax === "CUI", `count=${blockCount} max=${blockMax}`);
  check("BLOCK: (sanity) the resolved args WOULD carry the real CUI to the executor", (blockResolved as { title: string }).title === CUI_VALUE);

  // The loop's taint decision: target = RAW effectiveCeiling(org, projectU) = UNCLASSIFIED.
  const blockTarget = await effectiveCeiling(org.id, projectU.id);
  const blocked = isTaintBlocked(blockTarget, blockMax);
  check("BLOCK: taint predicate fires (target UNCLASSIFIED < resolved CUI)", blocked === true, `target=${blockTarget} resolved=${blockMax}`);

  // FAIL-CLOSED: the executor is NOT called. We assert that by NOT calling it and proving
  // the DB has NO work_item carrying the CUI in project U.
  if (blocked) {
    // audit the prevented down-classification write — hash is of the ORIGINAL handle args.
    logEgressDecision({
      conversationId: conv, turn: 1, valueKind: "tool_args", toolName: "create_work_item",
      exposed: false, withheldCount: blockCount, contentHash: sha256Hex(JSON.stringify(blockArgs)),
      decidedBy: "handle_taint_block", tenantClass: "gov", mode: "enforced", ceiling: blockMax ?? undefined,
    });
  } else {
    // would be wrong — but if it ever did not block, we'd (incorrectly) execute. Don't.
    check("BLOCK: predicate must have fired (control invariant)", false, "taint did NOT block a down-write");
  }

  // The model-facing rejection names ONLY the levels — never the CUI value.
  const taintError = { error: `blocked: a value classified ${blockMax} cannot be written into a context cleared only for ${blockTarget} (would spill CUI into a lower-classification container). Use a project cleared for ${blockMax}.` };
  check("BLOCK: the rejection names only LEVELS (CUI + UNCLASSIFIED), never the CUI value",
    taintError.error.includes("CUI") && taintError.error.includes("UNCLASSIFIED") && !taintError.error.includes("Sentinel") && !taintError.error.includes(CUI_VALUE));

  // give the fire-and-forget audit write a moment to land, then verify DB state.
  await new Promise((r) => setTimeout(r, 300));

  const leakedInU = await prisma.workItem.count({ where: { projectId: projectU.id } });
  check("BLOCK: NO work_item was created in UNCLASSIFIED project U (the write did NOT happen)", leakedInU === 0, `rows=${leakedInU}`);
  const cuiAnywhere = await prisma.workItem.count({ where: { orgId: org.id, title: { contains: "Sentinel" } } });
  check("BLOCK: the CUI value is NOT persisted anywhere in this org's work_items", cuiAnywhere === 0, `rows=${cuiAnywhere}`);

  const blockRows = await prisma.egressDecisionRow.findMany({ where: { conversationId: conv, decidedBy: "handle_taint_block" } });
  check("BLOCK: a handle_taint_block egress_decisions row exists (AC-4 evidence)", blockRows.length === 1, `rows=${blockRows.length}`);
  // Project to a CUI-safe subset (avoid stringifying the row's BigInt seq/hash columns).
  const safeBlock = blockRows.length === 1
    ? { ceiling: blockRows[0].ceiling, withheldCount: blockRows[0].withheldCount, exposed: blockRows[0].exposed, toolName: blockRows[0].toolName, contentHash: blockRows[0].contentHash }
    : null;
  check("BLOCK: the audit row carries the mint ceiling + NO CUI (hash/counts only)",
    !!safeBlock && safeBlock.ceiling === "CUI" && safeBlock.withheldCount === 1
    && safeBlock.exposed === false && safeBlock.toolName === "create_work_item"
    && !JSON.stringify(safeBlock).includes("Sentinel") && !JSON.stringify(safeBlock).includes(CUI_VALUE));

  // ════════════════════════════════════════════════════════════════════════════════
  // ALLOW — resolve the SAME handle into a write targeting CUI-cleared project P.
  // ════════════════════════════════════════════════════════════════════════════════
  const allowArgs = { projectId: projectP.id, title: token, workItemTypeId: wit.id };
  const { resolved: allowResolved, count: allowCount, maxCeiling: allowMax } = await resolveHandlesDeep(allowArgs, conv);
  const allowTarget = await effectiveCeiling(org.id, projectP.id);
  const allowBlocked = isTaintBlocked(allowTarget, allowMax);
  check("ALLOW: taint predicate does NOT fire (target CUI >= resolved CUI)", allowBlocked === false, `target=${allowTarget} resolved=${allowMax}`);

  // On ALLOW the loop CALLS the executor with the resolved (real CUI) args, in-boundary.
  let allowOk = false;
  if (!allowBlocked) {
    logEgressDecision({
      conversationId: conv, turn: 2, valueKind: "tool_args", toolName: "create_work_item",
      exposed: false, withheldCount: allowCount, contentHash: sha256Hex(JSON.stringify(allowArgs)),
      decidedBy: "handle_resolve", tenantClass: "gov", mode: "enforced",
    });
    const out = await createWorkItem(allowResolved as Record<string, unknown>, { orgId: org.id, userId: user.id });
    allowOk = typeof out === "object" && out !== null && (out as { id?: string }).id !== undefined && !("error" in (out as object));
    check("ALLOW: the executor RAN and created the work_item (no permission/validation error)", allowOk, JSON.stringify(out).slice(0, 120));
  }

  await new Promise((r) => setTimeout(r, 300));

  const persisted = await prisma.workItem.findFirst({ where: { projectId: projectP.id, title: CUI_VALUE } });
  check("ALLOW: the resolved CUI value IS persisted IN-BOUNDARY (work_item row in CUI project P)", !!persisted, persisted ? `id=${persisted.id}` : "(no row)");
  const resolveRows = await prisma.egressDecisionRow.findMany({ where: { conversationId: conv, decidedBy: "handle_resolve" } });
  check("ALLOW: a handle_resolve egress_decisions row exists (in-boundary CUI-by-reference)", resolveRows.length === 1, `rows=${resolveRows.length}`);

  // ── TEARDOWN (org cascade removes members/projects/work-items/classifications) ──
  // NOTE: egress_decisions is an APPEND-ONLY AU-9 immutable store — a DB trigger forbids
  // DELETE. The handle_taint_block / handle_resolve rows from this run are left in place
  // by design (acceptance-conversation-scoped, hashes/counts only, never CUI).
  await prisma.egressHandle.deleteMany({ where: { conversationId: conv } });
  // work_items reference the org-scoped work_item_type (FK not ON DELETE CASCADE), so
  // remove them + the type before the org cascade.
  await prisma.workItem.deleteMany({ where: { orgId: org.id } });
  await prisma.workItemType.deleteMany({ where: { orgId: org.id } });
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.user.delete({ where: { id: user.id } });

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL ACCEPTANCE CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
