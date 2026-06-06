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
import { prisma } from "../../src/lib/db/client";

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
  const { modelView: augmented, minted } = await augmentWithHandles(modelView, source, "work_item", convA);
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
  const { resolved, count } = await resolveHandlesDeep(toolArgs, convA);
  const r = resolved as typeof toolArgs;
  check("RESOLVE: 2 handle occurrences resolved in the tool args", count === 2, `count=${count}`);
  check("RESOLVE: the executor would receive the REAL CUI value (whole-string arg)", r.content === CUI);
  check("RESOLVE: the nested handle also resolves to the real value", r.nested.tags[1] === CUI);
  check("RESOLVE: a single resolveHandle returns the real value in-conversation", (await resolveHandle(convA, token)) === CUI);

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
  const { minted: projMint } = await augmentWithHandles(projectResult(projSource, "project"), projSource, "project", convA);
  check("DEFAULT-DENY: a non-HANDLEABLE entity (project.name) mints NO handle", projMint === 0);

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL ACCEPTANCE CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
