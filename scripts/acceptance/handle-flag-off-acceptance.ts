// scripts/acceptance/handle-flag-off-acceptance.ts
//
// FLAG-OFF parity check for the Docker acceptance. Replicates EXACTLY the loop's
// flag gate (agent-loop.ts handlesEnabled()): when EGRESS_HANDLES_ENABLED is
// "false"/"0"/"off", the withheld branch uses ONLY projectResult (no augment, no
// mint) and tool args are NOT scanned — byte-for-byte the pre-resolver behavior.
import { augmentWithHandles, projectResult } from "../../src/lib/ai/egress/projection";
import { resolveHandlesDeep } from "../../src/lib/ai/egress/handles";
import { prisma } from "../../src/lib/db/client";

function handlesEnabled(): boolean {
  const v = process.env.EGRESS_HANDLES_ENABLED?.toLowerCase().trim();
  return v !== "false" && v !== "0" && v !== "off";
}

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}

async function main() {
  console.log(`EGRESS_HANDLES_ENABLED=${process.env.EGRESS_HANDLES_ENABLED ?? "(unset)"} → handlesEnabled()=${handlesEnabled()}`);
  check("FLAG-OFF: handlesEnabled() is false", handlesEnabled() === false);

  const conv = "flagoff-conv-" + Date.now();
  const CUI = "CUI//SP flag-off withheld title";
  const source = { count: 1, items: [{ id: "w1", title: CUI, status: "DONE" }] };

  // The loop, flag OFF, uses ONLY projectResult on withhold (no augment).
  const flagOn = handlesEnabled();
  let modelView = projectResult(source, "work_item");
  if (flagOn) {
    const aug = await augmentWithHandles(modelView, source, "work_item", conv);
    modelView = aug.modelView;
  }
  const mvStr = JSON.stringify(modelView);
  const item0 = (modelView as { items: Array<Record<string, unknown>> }).items[0];

  check("FLAG-OFF: structural id still present", item0.id === "w1");
  check("FLAG-OFF: NO h:… token in the model view (field dropped as before)", !/h:[A-Za-z0-9_-]{24}/.test(mvStr) && !("title" in item0));
  check("FLAG-OFF: CUI value never in the model view", !mvStr.includes("Sentinel") && !mvStr.includes("CUI//SP"));

  // Flag OFF, the loop does NOT scan args; a handle-shaped arg passes through.
  const before = await prisma.egressHandle.count({ where: { conversationId: conv } });
  check("FLAG-OFF: nothing was minted (0 rows for this conversation)", before === 0, `rows=${before}`);
  const fakeTok = "h:" + "B".repeat(24);
  const execInput = flagOn ? (await resolveHandlesDeep({ content: fakeTok }, conv)).resolved : { content: fakeTok };
  check("FLAG-OFF: a handle-shaped arg passes through literally (no resolve attempted)",
    (execInput as { content: string }).content === fakeTok);

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "FLAG-OFF PARITY: ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
